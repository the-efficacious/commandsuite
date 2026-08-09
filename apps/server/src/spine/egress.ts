/**
 * Where a probe is allowed to point its camera, and how the answer is
 * made to hold at the moment of connection rather than at the moment of
 * checking.
 *
 * THE HOLE THIS CLOSES, stated plainly because the shape of it is the
 * whole design. An `http_poll` recipe's only destination pin was
 * `https:`. A member could therefore author
 * `https://169.254.169.254/latest/meta-data/iam/security-credentials/`
 * — or `10.0.0.5`, `127.0.0.1:8443`, `vault.internal:8200`,
 * `kubernetes.default.svc` — and the server would fetch it from inside
 * the deployment's network, attach the member's own auth secret as a
 * header, and write up to 8 KiB of the response into a PERMANENT annex
 * observation that every other member can read at `GET /spine/events`.
 * That is a server-side request forgery with a durable, team-readable
 * exfiltration channel bolted on, and the recipe is a legitimate act of
 * authorship rather than an attack that has to get past anything.
 *
 * TWO CHECKS, AND THE SECOND ONE IS THE LOAD-BEARING ONE.
 *
 *   AT AUTHORING — an IP literal in a blocked range is refused at the
 *   keyboard, like every other poll pin, because that is the only
 *   moment a member is present to be told. It catches the honest
 *   mistake and it catches the obvious attempt. It cannot catch a NAME.
 *
 *   AT FIRE TIME — the hostname is resolved and EVERY returned address
 *   is checked. This is the one that actually holds: `vault.internal`,
 *   `metadata.google.internal` and an attacker-controlled name with an
 *   A record pointing at 127.0.0.1 are all names, and no amount of
 *   string inspection at authoring time distinguishes them from
 *   `api.github.com`.
 *
 * AND THE CONNECTION IS PINNED TO THE ADDRESS THAT WAS CHECKED, which
 * is the part that is easy to leave out and useless to leave out.
 * Resolve-then-fetch is a time-of-check/time-of-use bug: the resolver
 * answers `93.184.216.34`, the check passes, and `fetch` resolves the
 * name AGAIN on its own and gets `127.0.0.1` from the second answer of
 * a round-robin record with a one-second TTL. That is DNS rebinding,
 * it is the standard defeat for exactly this control, and the only
 * answer is to connect to the address you checked. `createPinnedFetch`
 * hands `node:https` a `lookup` that returns the checked addresses and
 * nothing else, so the socket goes where the check said it could.
 *
 * TLS IS UNAFFECTED, which is why pinning is done this way rather than
 * by rewriting the URL to the IP. The request still carries the
 * hostname in `Host` and in SNI, so certificate validation is the
 * ordinary validation against the name the member authored.
 *
 * THE ESCAPE HATCH IS SERVER CONFIG, NEVER THE RECIPE. A team that
 * genuinely polls something internal sets an allowlist on the server;
 * a member cannot grant themselves an exception inside the request they
 * are making, which is the only property that makes the control mean
 * anything. Empty by default.
 */

import { lookup as dnsLookup } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';

/**
 * IPv4 ranges a probe may not reach, as [prefix, bits].
 *
 * The first seven are the ones a link-local metadata service, a
 * cluster-internal address or a loopback listener actually live in.
 * Multicast and reserved are included because nothing behind them is
 * an HTTPS API a member meant to poll, and refusing them costs a
 * legitimate caller nothing.
 */
const BLOCKED_V4: readonly [string, number][] = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // RFC 1918
  ['100.64.0.0', 10], // RFC 6598 carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local — the cloud metadata services
  ['172.16.0.0', 12], // RFC 1918
  ['192.168.0.0', 16], // RFC 1918
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, and 255.255.255.255 with it
];

/** IPv6 ranges, as [prefix, bits], with v4-mapped forms handled separately. */
const BLOCKED_V6: readonly [string, number][] = [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['fc00::', 7], // unique-local
  ['fe80::', 10], // link-local
];

function v4ToInt(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out = (out << 8) | n;
  }
  return out >>> 0;
}

/** Expand an IPv6 address to its sixteen bytes, or `null` if it will not parse. */
function v6ToBytes(address: string): number[] | null {
  let text = address;
  // A v4-mapped or v4-compatible tail (`::ffff:10.0.0.5`) is really a
  // v4 address wearing a v6 spelling, and treating it as opaque v6 is
  // exactly how a blocklist gets walked around.
  const tail = /:(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail !== null) {
    const asInt = v4ToInt(tail[1] as string);
    if (asInt === null) return null;
    const hi = ((asInt >>> 16) & 0xffff).toString(16);
    const lo = (asInt & 0xffff).toString(16);
    text = `${text.slice(0, tail.index)}:${hi}:${lo}`;
  }
  const [head, rest] = text.split('::') as [string, string | undefined];
  const headGroups = head.length > 0 ? head.split(':') : [];
  const tailGroups = rest !== undefined && rest.length > 0 ? rest.split(':') : [];
  if (rest === undefined && headGroups.length !== 8) return null;
  const fill = 8 - headGroups.length - tailGroups.length;
  if (fill < 0) return null;
  const groups = [...headGroups, ...Array(rest === undefined ? 0 : fill).fill('0'), ...tailGroups];
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const group of groups) {
    const n = Number.parseInt(group, 16);
    if (!Number.isInteger(n) || n < 0 || n > 0xffff) return null;
    bytes.push((n >> 8) & 0xff, n & 0xff);
  }
  return bytes;
}

function v4InRange(address: number, [prefix, bits]: readonly [string, number]): boolean {
  const base = v4ToInt(prefix);
  if (base === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (address & mask) >>> 0 === (base & mask) >>> 0;
}

function v6InRange(bytes: number[], [prefix, bits]: readonly [string, number]): boolean {
  const base = v6ToBytes(prefix);
  if (base === null) return false;
  for (let i = 0; i < bits; i++) {
    const byte = i >> 3;
    const bit = 7 - (i & 7);
    const a = ((bytes[byte] as number) >> bit) & 1;
    const b = ((base[byte] as number) >> bit) & 1;
    if (a !== b) return false;
  }
  return true;
}

/**
 * Why this address is off limits, or `null` when it is reachable.
 *
 * Returns a REASON rather than a boolean because the reason is what a
 * member sees in the refusal, and "that address is inside the
 * deployment's own network" is actionable in a way that "blocked" is
 * not.
 */
export function blockedAddressReason(address: string): string | null {
  const family = isIP(address);
  if (family === 4) {
    const asInt = v4ToInt(address);
    if (asInt === null) return `${address} is not an address this server can reason about`;
    for (const range of BLOCKED_V4) {
      if (v4InRange(asInt, range)) {
        return (
          `${address} is inside ${range[0]}/${range[1]}, which is private, loopback, ` +
          'link-local or reserved — not somewhere a team API lives'
        );
      }
    }
    return null;
  }
  if (family === 6) {
    const bytes = v6ToBytes(address);
    if (bytes === null) return `${address} is not an address this server can reason about`;
    // A v4-mapped v6 address is a v4 address, and is judged as one.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped !== null) return blockedAddressReason(mapped[1] as string);
    if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
      const v4 = bytes.slice(12).join('.');
      return blockedAddressReason(v4);
    }
    for (const range of BLOCKED_V6) {
      if (v6InRange(bytes, range)) {
        return (
          `${address} is inside ${range[0]}/${range[1]}, which is loopback, unique-local ` +
          'or link-local — not somewhere a team API lives'
        );
      }
    }
    return null;
  }
  return `${address} is not an IP address`;
}

/**
 * The IP a hostname literally IS, or `null` when it is a name.
 *
 * `new URL()` brackets an IPv6 literal, so the brackets come off before
 * anything looks at it — `[::1]` and `::1` are the same destination and
 * a check that saw only one of them would be a check with a documented
 * bypass.
 */
export function hostAsIpLiteral(hostname: string): string | null {
  const bare =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  return isIP(bare) === 0 ? null : bare;
}

/**
 * The AUTHORING half: what a URL's own text says about where it goes.
 *
 * Names are not judged here, and that is not an oversight — it is the
 * reason the fire-time half exists. `vault.internal` is a perfectly
 * well-formed hostname and the only way to know where it points is to
 * ask a resolver.
 */
export function blockedUrlReason(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'not a URL';
  }
  if (url.protocol !== 'https:') return 'not https';
  const literal = hostAsIpLiteral(url.hostname);
  if (literal === null) return null;
  return blockedAddressReason(literal);
}

export interface EgressPolicyOptions {
  /**
   * Hostnames a deployment has decided its probes may reach anyway.
   *
   * SERVER CONFIG, and it is the only place this can live. An
   * exception inside the recipe would be a member authorising their own
   * exception in the same breath as the request, which is not a control
   * at all. Empty by default: a deployment that needs internal polling
   * says so once, out of band, where whoever runs the server can see
   * it.
   *
   * Matched on the exact hostname, lower-cased. Not a range and not a
   * suffix: `internal.example.com` does not admit
   * `evil.internal.example.com`, and a wildcard would re-open the hole
   * for the deployment that reached for the convenient spelling.
   */
  allowHosts?: readonly string[];
  /** Injected so the check is testable without a resolver. */
  resolve?: (hostname: string) => Promise<string[]>;
}

export type EgressDecision =
  | { ok: true; addresses: string[]; allowlisted: boolean }
  | { ok: false; reason: string };

export interface EgressPolicy {
  /** Resolve and judge. Every returned address must pass, not merely the first. */
  check(hostname: string): Promise<EgressDecision>;
  /** The hostnames this deployment excepted, for the refusal to name. */
  readonly allowHosts: readonly string[];
}

function defaultResolve(hostname: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses.map((a) => a.address));
    });
  });
}

export function createEgressPolicy(options: EgressPolicyOptions = {}): EgressPolicy {
  const allowHosts = (options.allowHosts ?? []).map((h) => h.toLowerCase());
  const resolve = options.resolve ?? defaultResolve;
  return {
    allowHosts,
    async check(hostname: string): Promise<EgressDecision> {
      const bare = hostAsIpLiteral(hostname) ?? hostname.toLowerCase();
      if (allowHosts.includes(bare)) {
        // Still resolved, because the connection has to be pinned to
        // SOMETHING and the allowlist decides whether an address is
        // permitted, not whether the name gets to skip resolution.
        try {
          return { ok: true, addresses: await resolve(bare), allowlisted: true };
        } catch (err) {
          return { ok: false, reason: `${bare} did not resolve: ${asMessage(err)}` };
        }
      }
      const literal = hostAsIpLiteral(hostname);
      if (literal !== null) {
        const blocked = blockedAddressReason(literal);
        return blocked === null
          ? { ok: true, addresses: [literal], allowlisted: false }
          : { ok: false, reason: blocked };
      }
      let addresses: string[];
      try {
        addresses = await resolve(bare);
      } catch (err) {
        // A NAME THAT DOES NOT RESOLVE IS REFUSED, not attempted.
        // `kubernetes.default.svc` resolves inside a cluster and
        // nowhere else, so "we could not look it up" is not a reason
        // to hand the name to a socket and find out.
        return { ok: false, reason: `${bare} did not resolve: ${asMessage(err)}` };
      }
      if (addresses.length === 0) return { ok: false, reason: `${bare} resolved to no addresses` };
      for (const address of addresses) {
        const blocked = blockedAddressReason(address);
        if (blocked !== null) {
          // EVERY address, not the first. A name with one public A
          // record and one loopback A record is a name that reaches
          // loopback half the time, and "half the time" is not a
          // security property.
          return { ok: false, reason: `${bare} resolves to ${blocked}` };
        }
      }
      return { ok: true, addresses, allowlisted: false };
    },
  };
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * How the engine reaches the world, with the checked addresses carried
 * in rather than re-derived.
 *
 * The pin is a PARAMETER and not an implementation detail, because a
 * transport that resolved the name itself would undo the check no
 * matter how carefully the check was written. Any replacement — a
 * deployment's egress proxy, a test's script — is handed the same
 * addresses and is accountable for the same property.
 */
export type ProbeTransport = (
  url: URL,
  init: {
    method: 'GET';
    headers: Record<string, string>;
    redirect: 'manual';
    signal: AbortSignal;
    /** The addresses the policy approved. The socket may go to these and nowhere else. */
    pinnedAddresses: readonly string[];
  },
) => Promise<Response>;

/**
 * The default transport: `node:https` with a `lookup` that answers only
 * with addresses the policy already approved.
 *
 * `fetch` cannot express this. Its resolution is undici's and there is
 * no supported seam for a custom lookup without constructing a
 * dispatcher, so a `fetch`-based poll is a resolve-then-fetch and
 * therefore rebindable by construction. This is the whole reason the
 * transport is not `typeof fetch`.
 *
 * Redirects are not followed here either — `node:https` does not follow
 * them at all — so the engine's 3xx branch sees the response the server
 * actually sent.
 */
export function createPinnedFetch(): ProbeTransport {
  return (url, init) =>
    new Promise<Response>((resolve, reject) => {
      const pinned = [...init.pinnedAddresses];
      if (pinned.length === 0) {
        reject(new Error('refusing to connect with no checked address to pin to'));
        return;
      }
      const req = httpsRequest(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port === '' ? 443 : Number(url.port),
          path: `${url.pathname}${url.search}`,
          method: 'GET',
          headers: init.headers,
          // SNI and certificate validation stay bound to the NAME the
          // member authored; only the socket's destination is pinned.
          servername: hostAsIpLiteral(url.hostname) === null ? url.hostname : undefined,
          lookup: (_hostname, opts, cb) => {
            const family = isIP(pinned[0] as string);
            if (typeof opts === 'object' && opts !== null && opts.all === true) {
              (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(
                null,
                pinned.map((address) => ({ address, family: isIP(address) })),
              );
              return;
            }
            (cb as unknown as (e: null, a: string, f: number) => void)(
              null,
              pinned[0] as string,
              family,
            );
          },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          const headers = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (typeof value === 'string') headers.set(key, value);
            else if (Array.isArray(value)) headers.set(key, value.join(', '));
          }
          // 204/304 must not carry a body, and constructing a Response
          // with one throws.
          const body =
            status === 204 || status === 304 || (status >= 100 && status < 200)
              ? null
              : (Readable.toWeb(res) as ReadableStream<Uint8Array>);
          resolve(new Response(body, { status, headers }));
        },
      );
      req.on('error', reject);
      init.signal.addEventListener('abort', () => req.destroy(new Error('poll timed out')), {
        once: true,
      });
      req.end();
    });
}
