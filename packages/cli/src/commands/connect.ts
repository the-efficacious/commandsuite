/**
 * `csuite connect` — device-code enrollment from the CLI side.
 *
 * Replaces the "create a member, copy the token, paste it into your
 * config" onboarding flow with the gh-auth-style two-leg handshake:
 *
 *   0. Prompt for the broker URL when neither `--url` nor `CSUITE_URL`
 *      was provided (default `http://127.0.0.1:8717`). A bare Enter
 *      accepts the default.
 *   1. CLI POSTs /enroll → broker mints (deviceCode, userCode)
 *   2. CLI prints `userCode` + verification URL to the operator,
 *      then polls /enroll/poll every `interval` seconds
 *   3. Director, signed in via TOTP at the broker URL, types the
 *      code into the SPA and approves
 *   4. CLI's next poll resolves with the token; CLI persists it to
 *      `./.csuite/auth.json` (project-scoped) and exits
 *
 * The bearer token plaintext is never echoed to either operator's
 * terminal scrollback — it goes straight from the broker to the CLI's
 * persisted config. Cancellation: SIGINT / SIGTERM exits with a
 * "no token saved" message; the broker-side row expires on its own
 * 5-minute TTL.
 *
 * Backward compatibility: `csuite connect` is additive. The existing
 * `--token` / `CSUITE_TOKEN` paths keep working unchanged. The wizard
 * still mints the first admin's bootstrap token directly (no
 * director exists yet to approve).
 */

import { relative } from 'node:path';
import { Client, ClientError } from 'csuite-sdk/client';
import { DEFAULT_PORT, ENV } from 'csuite-sdk/protocol';
import { authConfigPath, findAuthConfigPath, saveAuthEntry } from './auth-config.js';
import { UsageError } from './errors.js';

export { UsageError };

export interface ConnectCommandInput {
  url?: string;
  /** Suggested label the director can accept or override on approve. */
  label?: string;
  /**
   * If true, skip writing `auth.json` and print the token to stdout
   * instead. Escape hatch for testing / debugging only — the default
   * (write to file) is what makes the flow paste-leak-free.
   */
  noWrite?: boolean;
  /** Suppress the box-banner; emit only minimal status lines. */
  quiet?: boolean;
  /**
   * Override the auth-config path. Used by tests to keep the user's
   * real config untouched. Set via `--auth-config`.
   */
  authConfigPath?: string;
  /** Custom fetch implementation for tests. */
  fetch?: typeof fetch;
  /** Test-only clock injection. */
  now?: () => number;
  /**
   * Prompt the operator for a single line of input. Used to ask for
   * the broker URL when neither `--url` nor `CSUITE_URL` was provided.
   * Returns the raw answer (no trim). Tests inject this; in production
   * we wire up a readline-backed default.
   */
  prompt?: (question: string) => Promise<string>;
}

export interface ConnectCommandOutput {
  url: string;
  token: string;
  tokenId: string;
  member: { name: string };
}

/** Render the box-banner with verification URL + user code. */
function renderBanner(verificationUrl: string, userCode: string, ttlSeconds: number): string {
  // Width is the longer of "visit:  <url>" or "code:   <code>", plus
  // 4 chars padding (`│  …  │`) so the box always lines up.
  const lines = [`visit:  ${verificationUrl}`, `code:   ${userCode}`, `expires in ${ttlSeconds}s`];
  const width = Math.max(...lines.map((l) => l.length)) + 4;
  const top = `┌${'─'.repeat(width)}┐`;
  const bot = `└${'─'.repeat(width)}┘`;
  const padded = lines.map((l) => `│  ${l.padEnd(width - 4)}  │`);
  return ['', top, ...padded, bot, ''].join('\n');
}

/**
 * Sleep for `ms`, but reject on the abort signal so SIGINT exits
 * the polling loop immediately. `setTimeout`'s built-in `AbortSignal`
 * support keeps this dependency-free.
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Drive the device-code flow from the CLI. Returns the saved entry
 * on success; throws `UsageError` on input/usage mistakes and
 * surface-level network failures, or `ConnectCancelled` if the
 * operator hits Ctrl-C.
 */
export async function runConnectCommand(
  input: ConnectCommandInput,
  stdout: (line: string) => void,
  stderr: (line: string) => void,
  abortSignal?: AbortSignal,
): Promise<ConnectCommandOutput> {
  // `--url` flag and `CSUITE_URL` env both bypass the prompt — they're
  // explicit "use this URL" signals (CI, scripts, sticky shell env).
  // Only with neither do we run the wizard; a bare Enter accepts the
  // local-broker default. The banner that follows shows the URL so
  // the operator still gets eyes-on confirmation before approving.
  const defaultUrl = `http://127.0.0.1:${DEFAULT_PORT}`;
  let url = input.url ?? process.env[ENV.url];
  if (!url) {
    const ask = input.prompt ?? defaultPrompt;
    const answer = (await ask(`Broker URL [${defaultUrl}]: `)).trim();
    url = answer.length > 0 ? answer : defaultUrl;
  }
  if (!/^https?:\/\//.test(url)) {
    throw new UsageError(`connect: URL must be http(s)://… (got '${url}')`);
  }

  // Use the SDK Client with skipAuth on the calls that need it.
  // Passing a placeholder token satisfies the constructor's "either
  // token or cookies" guard without ever sending it (the device-code
  // endpoints all `skipAuth: true`).
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const client = new Client({
    url,
    token: 'unused-during-enrollment',
    fetch: fetchImpl,
  });

  // Compose internal abort: SIGINT/SIGTERM + caller-supplied signal.
  const abortController = new AbortController();
  const onSig = (): void => abortController.abort();
  process.on('SIGINT', onSig);
  process.on('SIGTERM', onSig);
  const cleanup = (): void => {
    process.off('SIGINT', onSig);
    process.off('SIGTERM', onSig);
  };
  if (abortSignal) {
    if (abortSignal.aborted) abortController.abort();
    else abortSignal.addEventListener('abort', () => abortController.abort(), { once: true });
  }

  try {
    // Step 1: mint device + user codes.
    let mint: Awaited<ReturnType<typeof client.beginDeviceAuthorization>>;
    try {
      const labelHint = input.label ?? defaultLabelHint();
      mint = await client.beginDeviceAuthorization({ labelHint });
    } catch (err) {
      if (err instanceof ClientError) {
        if (err.status === 429) {
          throw new UsageError(
            `connect: broker rate-limited this device (HTTP 429). Try again in a few minutes.`,
          );
        }
        throw new UsageError(`connect: failed to start enrollment (HTTP ${err.status})`);
      }
      throw new UsageError(
        `connect: failed to reach broker at ${url}\n` +
          `  ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Step 2: print URL + code, then poll.
    const verificationUrl = new URL(mint.verificationUriComplete, url).toString();
    if (!input.quiet) {
      stdout(renderBanner(verificationUrl, mint.userCode, mint.expiresIn));
    } else {
      stdout(`enroll: ${verificationUrl}`);
      stdout(`code:   ${mint.userCode}`);
    }
    stdout('  waiting for approval... (press Ctrl-C to cancel)');

    let interval = mint.interval;
    const startedAt = input.now?.() ?? Date.now();
    const deadline = startedAt + mint.expiresIn * 1000;

    while (true) {
      if (abortController.signal.aborted) {
        throw new UsageError('connect: cancelled by user — no token saved.');
      }
      // Sleep up to `interval` seconds, but never past the deadline.
      const t = input.now?.() ?? Date.now();
      const remaining = deadline - t;
      if (remaining <= 0) {
        throw new UsageError(
          'connect: enrollment expired (5 min TTL). Run `csuite connect` again to retry.',
        );
      }
      const waitMs = Math.min(interval * 1000, remaining);
      try {
        await sleep(waitMs, abortController.signal);
      } catch {
        throw new UsageError('connect: cancelled by user — no token saved.');
      }

      let outcome: Awaited<ReturnType<typeof client.pollDeviceToken>>;
      try {
        outcome = await client.pollDeviceToken(mint.deviceCode);
      } catch (err) {
        // Network blip — surface and retry on the next interval
        // rather than aborting; the TTL covers us.
        stderr(
          `connect: poll error (will retry): ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }

      switch (outcome.status) {
        case 'authorization_pending':
          // Normal pending state — keep polling.
          continue;
        case 'slow_down':
          // RFC 8628 §3.5 — increment poll interval by 5 s.
          interval += 5;
          continue;
        case 'expired_token':
          throw new UsageError(
            'connect: enrollment expired before approval. Run `csuite connect` again to retry.',
          );
        case 'access_denied': {
          const detail = outcome.description ? ` (${outcome.description})` : '';
          throw new UsageError(`connect: rejected by director${detail}.`);
        }
        case 'approved': {
          const { data } = outcome;
          if (!input.noWrite) {
            saveAuthEntry(
              {
                url,
                token: data.token,
                savedAt: input.now?.() ?? Date.now(),
              },
              input.authConfigPath,
            );
          }
          stdout('');
          stdout(`  approved ✓`);
          stdout(`  bound to: ${data.member.name}`);
          if (input.noWrite) {
            stdout(`  token: ${data.token}`);
          } else {
            stdout(`  saved to: ${authConfigDisplayPath(input.authConfigPath)}`);
            stdout(`  next: csuite claude  (or: csuite codex)`);
          }
          return {
            url,
            token: data.token,
            tokenId: data.tokenId,
            member: { name: data.member.name },
          };
        }
      }
    }
  } finally {
    cleanup();
  }
}

/**
 * Readline-backed prompt for the broker URL. Stays inline (no shared
 * wizard IO module) since `connect` only ever asks one question; the
 * dynamic `node:readline` import keeps the cold-start cost off the
 * non-interactive paths (`--url` flag / `CSUITE_URL` env).
 */
async function defaultPrompt(question: string): Promise<string> {
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolve) => {
      rl.question(question, (answer) => resolve(answer));
    });
  } finally {
    rl.close();
  }
}

/**
 * Default label hint when the operator didn't pass `--label`. Prefer
 * `$HOSTNAME` when set (the actual machine name); fall back to a
 * generic placeholder. The director can always override at approval.
 */
function defaultLabelHint(): string {
  const host = process.env.HOSTNAME?.trim();
  if (host && host.length > 0 && host.length <= 64) return host;
  return 'connected device';
}

/**
 * Render the auth-config path for display, preferring a `./`-prefixed
 * relative path when the file lives under cwd (the common case for
 * project-scoped configs). Falls back to absolute when the file lives
 * above cwd (re-`connect` from a subdir updating the project root).
 */
function authConfigDisplayPath(override: string | undefined): string {
  const path = override ?? findAuthConfigPath() ?? authConfigPath();
  const rel = relative(process.cwd(), path);
  if (!rel.startsWith('..') && !rel.startsWith('/')) return `./${rel}`;
  return path;
}
