/**
 * `csuite notifications` — manage External Notification endpoints,
 * shared auth profiles, and delivery receipts.
 *
 * An endpoint is a slug-addressed hook receiver (`POST /hooks/<slug>`
 * on the broker) that verifies inbound requests (HMAC or shared-
 * secret header), optionally filters/templates/debounces them, and
 * routes them to members (DM) or channels as ambient input. Signing
 * secrets are write-only: set here, KEK-encrypted at rest, never
 * returned — this command must not print one either. All mutations
 * require `notifications.manage`.
 *
 * Subcommands:
 *   csuite notifications list        [--json]
 *   csuite notifications view        <slug> [--json]
 *   csuite notifications add         <slug> --target <@member|#channel>...
 *                                    [--display-name <text>] [--description <text>]
 *                                    [--auth hmac-sha256|header-secret] [--auth-header <name>]
 *                                    [--auth-prefix <prefix>] [--profile <slug>]
 *                                    [--level <level>] [--title <text>] [--template <text>]
 *                                    [--if-offline drop|queue] [--if-busy now|wait]
 *                                    [--debounce-ms <n>] [--debounce-max <n>]
 *                                    [--queue-ttl-ms <n>] [--max-wait-ms <n>]
 *                                    [--dedupe-header <name>] [--disabled]
 *   csuite notifications update      <slug> [same flags as add, minus slug; --enabled true|false]
 *   csuite notifications rm          <slug>
 *   csuite notifications set-secret  <slug> [--secret <value>]
 *   csuite notifications delete-secret <slug>
 *   csuite notifications deliveries  <slug> [--limit <n>] [--json]
 *   csuite notifications replay      <deliveryId>
 *   csuite notifications profiles    list [--json]
 *   csuite notifications profiles    add <slug> --auth <kind> [--auth-header <name>]
 *                                    [--auth-prefix <prefix>] [--description <text>]
 *   csuite notifications profiles    rm <slug>
 *   csuite notifications profiles    set-secret <slug> [--secret <value>]
 *
 * `set-secret` without `--secret` reads the value from stdin: a
 * hidden prompt on a TTY, or the whole stream when piped.
 */

import { parseArgs } from 'node:util';
import type { Client } from 'csuite-sdk/client';
import type {
  LogLevel,
  NotificationAuthKind,
  NotificationDelivery,
  NotificationDeliveryPolicy,
  NotificationEndpointSummary,
  NotificationTarget,
} from 'csuite-sdk/types';
import { UsageError } from './errors.js';

export async function runNotificationsCommand(
  args: string[],
  client: Client,
  stdout: (line: string) => void,
): Promise<void> {
  const [sub, ...rest] = args;
  if (!sub || sub === '-h' || sub === '--help') {
    throw new UsageError(
      'notifications subcommand required. Use: list | view | add | update | rm | set-secret | delete-secret | deliveries | replay | profiles',
    );
  }
  switch (sub) {
    case 'list':
      await runList(rest, client, stdout);
      return;
    case 'view':
    case 'show':
      await runView(rest, client, stdout);
      return;
    case 'add':
    case 'create':
      await runAdd(rest, client, stdout);
      return;
    case 'update':
      await runUpdate(rest, client, stdout);
      return;
    case 'rm':
    case 'remove':
    case 'delete':
      await runRm(rest, client, stdout);
      return;
    case 'set-secret':
      await runSetSecret(rest, client, stdout, 'endpoint');
      return;
    case 'delete-secret':
      await runDeleteSecret(rest, client, stdout);
      return;
    case 'deliveries':
      await runDeliveries(rest, client, stdout);
      return;
    case 'replay':
      await runReplay(rest, client, stdout);
      return;
    case 'profiles':
      await runProfiles(rest, client, stdout);
      return;
    default:
      throw new UsageError(`unknown notifications subcommand: ${sub}`);
  }
}

function requireSlug(positionals: string[], noun = 'endpoint'): string {
  const slug = positionals[0];
  if (!slug) throw new UsageError(`an ${noun} slug is required`);
  return slug;
}

/** Parse a `--flag true|false` string option. */
function parseBoolFlag(name: string, raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new UsageError(`--${name} takes true or false`);
}

function parseIntFlag(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new UsageError(`--${name} takes a non-negative integer`);
  return n;
}

const AUTH_KINDS: NotificationAuthKind[] = ['hmac-sha256', 'header-secret'];

function parseAuthKind(raw: string | undefined): NotificationAuthKind | undefined {
  if (raw === undefined) return undefined;
  if ((AUTH_KINDS as string[]).includes(raw)) return raw as NotificationAuthKind;
  throw new UsageError(`--auth takes one of: ${AUTH_KINDS.join(', ')}`);
}

/** `@member` or `#channel` (bare names count as members). */
function parseTargets(raw: string[] | undefined): NotificationTarget[] | undefined {
  if (raw === undefined || raw.length === 0) return undefined;
  return raw.map((entry) => {
    if (entry.startsWith('#')) return { channel: entry.slice(1) };
    return { member: entry.startsWith('@') ? entry.slice(1) : entry };
  });
}

function describeTarget(t: NotificationTarget): string {
  return t.member !== undefined ? `@${t.member}` : `#${t.channel ?? '?'}`;
}

function formatEndpointLine(e: NotificationEndpointSummary): string {
  const flags = [
    e.enabled ? null : 'disabled',
    e.authProfile !== null ? `profile:${e.authProfile}` : e.auth.kind,
    e.hasSecret || e.authProfile !== null ? null : 'no-secret',
    e.policy.ifOffline === 'queue' ? 'queue-offline' : null,
    e.policy.ifBusy === 'wait' ? 'wait-busy' : null,
    e.policy.debounceMs > 0 ? `debounce:${e.policy.debounceMs}ms` : null,
  ]
    .filter(Boolean)
    .join(', ');
  const targets = e.targets.map(describeTarget).join(' ');
  return `- ${e.slug}  → ${targets}  (${flags})`;
}

function formatDeliveryLine(d: NotificationDelivery): string {
  const when = new Date(d.receivedAt).toISOString();
  const reason = d.statusReason ? `  ${d.statusReason}` : '';
  const replay = d.replayOf ? `  (replay of ${d.replayOf})` : '';
  return `- ${when}  ${d.status.padEnd(9)}  ${d.id}${reason}${replay}`;
}

interface EndpointFlagValues {
  'display-name'?: string;
  description?: string;
  auth?: string;
  'auth-header'?: string;
  'auth-prefix'?: string;
  profile?: string;
  level?: string;
  title?: string;
  template?: string;
  'if-offline'?: string;
  'if-busy'?: string;
  'debounce-ms'?: string;
  'debounce-max'?: string;
  'queue-ttl-ms'?: string;
  'max-wait-ms'?: string;
  'dedupe-header'?: string;
}

const ENDPOINT_FLAG_OPTIONS = {
  target: { type: 'string', multiple: true },
  'display-name': { type: 'string' },
  description: { type: 'string' },
  auth: { type: 'string' },
  'auth-header': { type: 'string' },
  'auth-prefix': { type: 'string' },
  profile: { type: 'string' },
  level: { type: 'string' },
  title: { type: 'string' },
  template: { type: 'string' },
  'if-offline': { type: 'string' },
  'if-busy': { type: 'string' },
  'debounce-ms': { type: 'string' },
  'debounce-max': { type: 'string' },
  'queue-ttl-ms': { type: 'string' },
  'max-wait-ms': { type: 'string' },
  'dedupe-header': { type: 'string' },
} as const;

function buildPolicy(values: EndpointFlagValues): Partial<NotificationDeliveryPolicy> {
  const policy: Partial<NotificationDeliveryPolicy> = {};
  const ifOffline = values['if-offline'];
  if (ifOffline !== undefined) {
    if (ifOffline !== 'drop' && ifOffline !== 'queue') {
      throw new UsageError('--if-offline takes drop or queue');
    }
    policy.ifOffline = ifOffline;
  }
  const ifBusy = values['if-busy'];
  if (ifBusy !== undefined) {
    if (ifBusy !== 'now' && ifBusy !== 'wait') {
      throw new UsageError('--if-busy takes now or wait');
    }
    policy.ifBusy = ifBusy;
  }
  const debounceMs = parseIntFlag('debounce-ms', values['debounce-ms']);
  if (debounceMs !== undefined) policy.debounceMs = debounceMs;
  const debounceMax = parseIntFlag('debounce-max', values['debounce-max']);
  if (debounceMax !== undefined) policy.debounceMax = debounceMax;
  const queueTtlMs = parseIntFlag('queue-ttl-ms', values['queue-ttl-ms']);
  if (queueTtlMs !== undefined) policy.queueTtlMs = queueTtlMs;
  const maxWaitMs = parseIntFlag('max-wait-ms', values['max-wait-ms']);
  if (maxWaitMs !== undefined) policy.maxWaitMs = maxWaitMs;
  return policy;
}

function buildAuth(
  values: EndpointFlagValues,
): { kind: NotificationAuthKind; headerName?: string | null; prefix?: string | null } | undefined {
  const kind = parseAuthKind(values.auth);
  if (kind === undefined) {
    if (values['auth-header'] !== undefined || values['auth-prefix'] !== undefined) {
      throw new UsageError('--auth-header/--auth-prefix require --auth <kind>');
    }
    return undefined;
  }
  return {
    kind,
    ...(values['auth-header'] !== undefined ? { headerName: values['auth-header'] } : {}),
    ...(values['auth-prefix'] !== undefined ? { prefix: values['auth-prefix'] } : {}),
  };
}

async function runList(
  args: string[],
  client: Client,
  stdout: (line: string) => void,
): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { json: { type: 'boolean' } },
    allowPositionals: false,
  });
  const endpoints = await client.listNotificationEndpoints();
  if (values.json) {
    stdout(JSON.stringify(endpoints, null, 2));
    return;
  }
  if (endpoints.length === 0) {
    stdout('(no notification endpoints registered)');
    return;
  }
  for (const e of endpoints) stdout(formatEndpointLine(e));
}

async function runView(
  args: string[],
  client: Client,
  stdout: (line: string) => void,
): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: { json: { type: 'boolean' } },
    allowPositionals: true,
  });
  const slug = requireSlug(positionals);
  const detail = await client.getNotificationEndpoint(slug);
  if (values.json) {
    stdout(JSON.stringify(detail, null, 2));
    return;
  }
  const e = detail.endpoint;
  stdout(formatEndpointLine(e));
  stdout(`  ingress: POST /hooks/${e.slug}`);
  if (e.description) stdout(`  description: ${e.description}`);
  if (e.authProfile !== null) {
    stdout(`  auth: profile '${e.authProfile}'`);
  } else {
    stdout(
      `  auth: ${e.auth.kind}${e.auth.headerName ? ` header=${e.auth.headerName}` : ''}${e.auth.prefix ? ` prefix=${e.auth.prefix}` : ''}${e.hasSecret ? '' : '  ⚠ no secret set — the endpoint rejects everything'}`,
    );
  }
  stdout(`  level: ${e.level}${e.dedupeHeader ? `  dedupe: ${e.dedupeHeader}` : ''}`);
  stdout(
    `  policy: if-offline=${e.policy.ifOffline} if-busy=${e.policy.ifBusy} debounce=${e.policy.debounceMs}ms/${e.policy.debounceMax}`,
  );
  if (e.filters.length > 0) stdout(`  filters: ${JSON.stringify(e.filters)}`);
  if (e.template !== null) stdout(`  template: ${e.template}`);
}

async function runAdd(
  args: string[],
  client: Client,
  stdout: (line: string) => void,
): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: { ...ENDPOINT_FLAG_OPTIONS, disabled: { type: 'boolean' } },
    allowPositionals: true,
  });
  const slug = requireSlug(positionals);
  const targets = parseTargets(values.target);
  if (!targets) {
    throw new UsageError('at least one --target <@member|#channel> is required');
  }
  const auth = buildAuth(values);
  const policy = buildPolicy(values);
  const endpoint = await client.createNotificationEndpoint({
    slug,
    targets,
    ...(values['display-name'] !== undefined ? { displayName: values['display-name'] } : {}),
    ...(values.description !== undefined ? { description: values.description } : {}),
    ...(auth !== undefined ? { auth } : {}),
    ...(values.profile !== undefined ? { authProfile: values.profile } : {}),
    ...(values.level !== undefined ? { level: values.level as LogLevel } : {}),
    ...(values.title !== undefined ? { title: values.title } : {}),
    ...(values.template !== undefined ? { template: values.template } : {}),
    ...(Object.keys(policy).length > 0 ? { policy } : {}),
    ...(values['dedupe-header'] !== undefined ? { dedupeHeader: values['dedupe-header'] } : {}),
    ...(values.disabled ? { enabled: false } : {}),
  });
  stdout(
    `registered endpoint '${endpoint.slug}' → ${endpoint.targets.map(describeTarget).join(' ')}`,
  );
  stdout(`ingress: POST <broker>/hooks/${endpoint.slug}`);
  if (endpoint.authProfile === null) {
    stdout(`next: csuite notifications set-secret ${slug}   (rejects everything until set)`);
  }
}

async function runUpdate(
  args: string[],
  client: Client,
  stdout: (line: string) => void,
): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: { ...ENDPOINT_FLAG_OPTIONS, enabled: { type: 'string' } },
    allowPositionals: true,
  });
  const slug = requireSlug(positionals);
  const targets = parseTargets(values.target);
  const auth = buildAuth(values);
  const policy = buildPolicy(values);
  const enabled = parseBoolFlag('enabled', values.enabled);
  const patch = {
    ...(targets !== undefined ? { targets } : {}),
    ...(values['display-name'] !== undefined ? { displayName: values['display-name'] } : {}),
    ...(values.description !== undefined ? { description: values.description } : {}),
    ...(auth !== undefined ? { auth } : {}),
    ...(values.profile !== undefined ? { authProfile: values.profile || null } : {}),
    ...(values.level !== undefined ? { level: values.level as LogLevel } : {}),
    ...(values.title !== undefined ? { title: values.title } : {}),
    ...(values.template !== undefined ? { template: values.template || null } : {}),
    ...(Object.keys(policy).length > 0 ? { policy } : {}),
    ...(values['dedupe-header'] !== undefined
      ? { dedupeHeader: values['dedupe-header'] || null }
      : {}),
    ...(enabled !== undefined ? { enabled } : {}),
  };
  if (Object.keys(patch).length === 0) {
    throw new UsageError('nothing to update — pass at least one flag');
  }
  const endpoint = await client.updateNotificationEndpoint(slug, patch);
  stdout(`updated endpoint '${endpoint.slug}'`);
}

async function runRm(
  args: string[],
  client: Client,
  stdout: (line: string) => void,
): Promise<void> {
  const { positionals } = parseArgs({ args, options: {}, allowPositionals: true });
  const slug = requireSlug(positionals);
  await client.deleteNotificationEndpoint(slug);
  stdout(`deleted endpoint '${slug}' (delivery receipts and queued deliveries removed)`);
}

async function runSetSecret(
  args: string[],
  client: Client,
  stdout: (line: string) => void,
  noun: 'endpoint' | 'profile',
): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: { secret: { type: 'string' } },
    allowPositionals: true,
  });
  const slug = requireSlug(positionals, noun);
  let secret = values.secret;
  if (secret === undefined) {
    secret = process.stdin.isTTY
      ? await promptHidden(`signing secret for '${slug}' (input hidden): `)
      : await readStdinValue();
  }
  if (!secret) {
    throw new UsageError(
      'a non-empty secret is required (--secret, hidden prompt, or piped stdin)',
    );
  }
  if (noun === 'endpoint') {
    await client.setNotificationEndpointSecret(slug, { secret });
  } else {
    await client.setNotificationProfileSecret(slug, { secret });
  }
  stdout(`secret set for '${slug}'. The secret is write-only from here.`);
}

async function runDeleteSecret(
  args: string[],
  client: Client,
  stdout: (line: string) => void,
): Promise<void> {
  const { positionals } = parseArgs({ args, options: {}, allowPositionals: true });
  const slug = requireSlug(positionals);
  await client.deleteNotificationEndpointSecret(slug);
  stdout(`secret removed from '${slug}' (the endpoint now rejects everything)`);
}

async function runDeliveries(
  args: string[],
  client: Client,
  stdout: (line: string) => void,
): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: { json: { type: 'boolean' }, limit: { type: 'string' } },
    allowPositionals: true,
  });
  const slug = requireSlug(positionals);
  const limit = parseIntFlag('limit', values.limit);
  const deliveries = await client.listNotificationDeliveries(
    slug,
    limit !== undefined ? { limit } : undefined,
  );
  if (values.json) {
    stdout(JSON.stringify(deliveries, null, 2));
    return;
  }
  if (deliveries.length === 0) {
    stdout('(no deliveries recorded)');
    return;
  }
  for (const d of deliveries) stdout(formatDeliveryLine(d));
}

async function runReplay(
  args: string[],
  client: Client,
  stdout: (line: string) => void,
): Promise<void> {
  const { positionals } = parseArgs({ args, options: {}, allowPositionals: true });
  const deliveryId = positionals[0];
  if (!deliveryId) throw new UsageError('a delivery id is required');
  const delivery = await client.replayNotificationDelivery(deliveryId);
  stdout(
    `replayed as ${delivery.id}: ${delivery.status}${delivery.statusReason ? ` (${delivery.statusReason})` : ''}`,
  );
}

async function runProfiles(
  args: string[],
  client: Client,
  stdout: (line: string) => void,
): Promise<void> {
  const [sub, ...rest] = args;
  if (!sub || sub === '-h' || sub === '--help') {
    throw new UsageError('profiles subcommand required. Use: list | add | rm | set-secret');
  }
  switch (sub) {
    case 'list': {
      const { values } = parseArgs({
        args: rest,
        options: { json: { type: 'boolean' } },
        allowPositionals: false,
      });
      const profiles = await client.listNotificationProfiles();
      if (values.json) {
        stdout(JSON.stringify(profiles, null, 2));
        return;
      }
      if (profiles.length === 0) {
        stdout('(no auth profiles registered)');
        return;
      }
      for (const p of profiles) {
        stdout(
          `- ${p.slug}  ${p.auth.kind}  (${p.hasSecret ? 'secret set' : 'no-secret'}, ${p.endpointCount} endpoint${p.endpointCount === 1 ? '' : 's'})`,
        );
      }
      return;
    }
    case 'add':
    case 'create': {
      const { values, positionals } = parseArgs({
        args: rest,
        options: {
          auth: { type: 'string' },
          'auth-header': { type: 'string' },
          'auth-prefix': { type: 'string' },
          description: { type: 'string' },
        },
        allowPositionals: true,
      });
      const slug = requireSlug(positionals, 'profile');
      const kind = parseAuthKind(values.auth);
      if (kind === undefined)
        throw new UsageError('--auth <hmac-sha256|header-secret> is required');
      const profile = await client.createNotificationProfile({
        slug,
        auth: {
          kind,
          ...(values['auth-header'] !== undefined ? { headerName: values['auth-header'] } : {}),
          ...(values['auth-prefix'] !== undefined ? { prefix: values['auth-prefix'] } : {}),
        },
        ...(values.description !== undefined ? { description: values.description } : {}),
      });
      stdout(`registered auth profile '${profile.slug}' (${profile.auth.kind})`);
      stdout(`next: csuite notifications profiles set-secret ${slug}`);
      return;
    }
    case 'rm':
    case 'remove':
    case 'delete': {
      const { positionals } = parseArgs({ args: rest, options: {}, allowPositionals: true });
      const slug = requireSlug(positionals, 'profile');
      await client.deleteNotificationProfile(slug);
      stdout(`deleted auth profile '${slug}'`);
      return;
    }
    case 'set-secret':
      await runSetSecret(rest, client, stdout, 'profile');
      return;
    default:
      throw new UsageError(`unknown profiles subcommand: ${sub}`);
  }
}

/**
 * Prompt on the TTY with echo disabled — same shape as the secrets
 * command's hidden prompt (see secrets.ts for the rationale).
 */
async function promptHidden(question: string): Promise<string> {
  const { createInterface } = await import('node:readline');
  const { Writable } = await import('node:stream');
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stdout.write(chunk);
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  try {
    return await new Promise<string>((resolve) => {
      rl.question(question, (answer) => resolve(answer));
      muted = true;
    });
  } finally {
    rl.close();
    process.stdout.write('\n');
  }
}

/** Read piped stdin as the secret, stripping exactly one trailing newline. */
async function readStdinValue(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '');
}
