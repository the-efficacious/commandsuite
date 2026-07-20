/**
 * `csuite tools` — manage the tool-source registry.
 *
 * Tool sources are platform-defined external tools distributed to
 * bound members via the briefing: `custom` sources carry declarative
 * HTTP-bound tool definitions the broker executes with a stored
 * credential; `mcp` sources proxy a remote MCP server. Registry
 * mutations require `tools.manage`; credentials are write-only.
 *
 * Subcommands:
 *   csuite tools list      [--json]
 *   csuite tools show      <slug> [--json]
 *   csuite tools add       <slug> --kind custom|mcp [--url <mcp url>]
 *                          [--name <display>] [--all-members]
 *   csuite tools rm        <slug>
 *   csuite tools enable    <slug> / disable <slug>
 *   csuite tools cred      <slug> --bearer <token> | --header <Name>=<value>
 *   csuite tools cred-rm   <slug>
 *   csuite tools bind      <slug> <member...> / unbind <slug> <member...>
 *   csuite tools def       <slug> <toolName> --file <tool.json>
 *   csuite tools def-rm    <slug> <toolName>
 *   csuite tools refresh   <slug>            (mcp discovery)
 *
 * The `def` file is JSON: { description, inputSchema, binding } —
 * see docs/concepts/tool-sources for the binding shape.
 */

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { Client } from 'csuite-sdk/client';
import { SetCustomToolRequestSchema } from 'csuite-sdk/schemas';
import type { ToolSourceKind, ToolSourceSummary } from 'csuite-sdk/types';
import { UsageError } from './errors.js';

export async function runToolsCommand(
  args: string[],
  client: Client,
  stdout: (line: string) => void,
): Promise<void> {
  const [sub, ...rest] = args;
  if (!sub || sub === '-h' || sub === '--help') {
    throw new UsageError(
      'tools subcommand required. Use: list | show | add | rm | enable | disable | cred | cred-rm | bind | unbind | def | def-rm | refresh',
    );
  }
  switch (sub) {
    case 'list':
      await runList(rest, client, stdout);
      return;
    case 'show':
      await runShow(rest, client, stdout);
      return;
    case 'add':
    case 'create':
      await runAdd(rest, client, stdout);
      return;
    case 'rm':
    case 'remove':
    case 'delete':
      await runRm(rest, client, stdout);
      return;
    case 'enable':
    case 'disable':
      await runEnableDisable(sub === 'enable', rest, client, stdout);
      return;
    case 'cred':
    case 'credential':
      await runCred(rest, client, stdout);
      return;
    case 'cred-rm':
      await runCredRm(rest, client, stdout);
      return;
    case 'bind':
      await runBind(true, rest, client, stdout);
      return;
    case 'unbind':
      await runBind(false, rest, client, stdout);
      return;
    case 'def':
    case 'define':
      await runDef(rest, client, stdout);
      return;
    case 'def-rm':
      await runDefRm(rest, client, stdout);
      return;
    case 'refresh':
      await runRefresh(rest, client, stdout);
      return;
    default:
      throw new UsageError(`unknown tools subcommand: ${sub}`);
  }
}

function requireSlug(positionals: string[]): string {
  const slug = positionals[0];
  if (!slug) throw new UsageError('a tool-source slug is required');
  return slug;
}

function formatSourceLine(s: ToolSourceSummary): string {
  const flags = [
    s.enabled ? null : 'disabled',
    s.allMembers ? 'all-members' : null,
    s.hasCredential ? 'cred' : 'no-cred',
  ]
    .filter(Boolean)
    .join(', ');
  const label = s.displayName ? ` "${s.displayName}"` : '';
  return `- ${s.slug} [${s.kind}]${label}  tools=${s.toolCount}  (${flags})`;
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
  const sources = await client.listToolSources();
  if (values.json) {
    stdout(JSON.stringify(sources, null, 2));
    return;
  }
  if (sources.length === 0) {
    stdout('(no tool sources registered)');
    return;
  }
  for (const s of sources) stdout(formatSourceLine(s));
}

async function runShow(
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
  const detail = await client.getToolSource(slug);
  if (values.json) {
    stdout(JSON.stringify(detail, null, 2));
    return;
  }
  stdout(formatSourceLine(detail.source));
  if (detail.source.kind === 'mcp' && detail.source.config.url) {
    stdout(`  upstream: ${detail.source.config.url}`);
  }
  if (detail.boundMembers !== undefined) {
    stdout(
      detail.boundMembers.length > 0
        ? `  bound: ${detail.boundMembers.join(', ')}`
        : '  bound: (none)',
    );
  }
  if (detail.tools.length === 0) {
    stdout('  tools: (none)');
    return;
  }
  stdout('  tools:');
  for (const t of detail.tools) {
    const desc = t.description.length > 80 ? `${t.description.slice(0, 77)}...` : t.description;
    stdout(`    ${t.name} — ${desc}`);
  }
}

async function runAdd(
  args: string[],
  client: Client,
  stdout: (line: string) => void,
): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      kind: { type: 'string' },
      url: { type: 'string' },
      name: { type: 'string' },
      'all-members': { type: 'boolean' },
      disabled: { type: 'boolean' },
    },
    allowPositionals: true,
  });
  const slug = requireSlug(positionals);
  const kind = values.kind;
  if (kind !== 'custom' && kind !== 'mcp') {
    throw new UsageError('--kind custom|mcp is required');
  }
  if (kind === 'mcp' && !values.url) {
    throw new UsageError('--url is required for mcp sources');
  }
  const source = await client.createToolSource({
    slug,
    kind: kind as ToolSourceKind,
    ...(values.name !== undefined ? { displayName: values.name } : {}),
    ...(values.url !== undefined ? { config: { url: values.url } } : {}),
    ...(values['all-members'] ? { allMembers: true } : {}),
    ...(values.disabled ? { enabled: false } : {}),
  });
  stdout(`registered tool source '${source.slug}' (${source.kind})`);
  if (kind === 'custom') {
    stdout(`next: csuite tools cred ${slug} --bearer <token>   (if the API needs auth)`);
    stdout(`      csuite tools def ${slug} <toolName> --file tool.json`);
    stdout(`      csuite tools bind ${slug} <member>`);
  } else {
    stdout(`next: csuite tools cred ${slug} --bearer <token>   (if the server needs auth)`);
    stdout(`      csuite tools refresh ${slug}`);
    stdout(`      csuite tools bind ${slug} <member>`);
  }
}

async function runRm(
  args: string[],
  client: Client,
  stdout: (line: string) => void,
): Promise<void> {
  const { positionals } = parseArgs({ args, options: {}, allowPositionals: true });
  const slug = requireSlug(positionals);
  await client.deleteToolSource(slug);
  stdout(`deleted tool source '${slug}' (bindings, credentials, and tool defs removed)`);
}

async function runEnableDisable(
  enable: boolean,
  args: string[],
  client: Client,
  stdout: (line: string) => void,
): Promise<void> {
  const { positionals } = parseArgs({ args, options: {}, allowPositionals: true });
  const slug = requireSlug(positionals);
  await client.updateToolSource(slug, { enabled: enable });
  stdout(`${enable ? 'enabled' : 'disabled'} tool source '${slug}'`);
}

async function runCred(
  args: string[],
  client: Client,
  stdout: (line: string) => void,
): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: { bearer: { type: 'string' }, header: { type: 'string' } },
    allowPositionals: true,
  });
  const slug = requireSlug(positionals);
  if (values.bearer && values.header) {
    throw new UsageError('pass --bearer OR --header, not both');
  }
  if (values.bearer) {
    await client.setToolCredential(slug, { kind: 'bearer', secret: values.bearer });
    stdout(`credential set for '${slug}' (bearer). The secret is write-only from here.`);
    return;
  }
  if (values.header) {
    const eq = values.header.indexOf('=');
    if (eq <= 0 || eq === values.header.length - 1) {
      throw new UsageError('--header takes <Name>=<value>');
    }
    const headerName = values.header.slice(0, eq);
    const secret = values.header.slice(eq + 1);
    await client.setToolCredential(slug, { kind: 'header', headerName, secret });
    stdout(
      `credential set for '${slug}' (header ${headerName}). The secret is write-only from here.`,
    );
    return;
  }
  throw new UsageError('pass --bearer <token> or --header <Name>=<value>');
}

async function runCredRm(
  args: string[],
  client: Client,
  stdout: (line: string) => void,
): Promise<void> {
  const { positionals } = parseArgs({ args, options: {}, allowPositionals: true });
  const slug = requireSlug(positionals);
  await client.deleteToolCredential(slug);
  stdout(`credential removed from '${slug}'`);
}

async function runBind(
  bind: boolean,
  args: string[],
  client: Client,
  stdout: (line: string) => void,
): Promise<void> {
  const { positionals } = parseArgs({ args, options: {}, allowPositionals: true });
  const [slug, ...memberNames] = positionals;
  if (!slug) throw new UsageError('a tool-source slug is required');
  if (memberNames.length === 0) {
    throw new UsageError(`at least one member name is required to ${bind ? 'bind' : 'unbind'}`);
  }
  for (const member of memberNames) {
    if (bind) {
      await client.bindToolSource(slug, { member });
      stdout(`bound ${member} to '${slug}'`);
    } else {
      await client.unbindToolSource(slug, member);
      stdout(`unbound ${member} from '${slug}'`);
    }
  }
}

async function runDef(
  args: string[],
  client: Client,
  stdout: (line: string) => void,
): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: { file: { type: 'string' } },
    allowPositionals: true,
  });
  const [slug, toolName] = positionals;
  if (!slug || !toolName) {
    throw new UsageError('usage: csuite tools def <slug> <toolName> --file <tool.json>');
  }
  if (!values.file) throw new UsageError('--file <tool.json> is required');
  let raw: string;
  try {
    raw = readFileSync(values.file, 'utf8');
  } catch (err) {
    throw new UsageError(
      `could not read ${values.file}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new UsageError(
      `${values.file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // Validate locally first so template typos surface with a zod path
  // instead of a bare 400.
  const validated = SetCustomToolRequestSchema.safeParse(parsed);
  if (!validated.success) {
    const issues = validated.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new UsageError(`${values.file} failed validation:\n${issues}`);
  }
  await client.setCustomTool(slug, toolName, validated.data);
  stdout(`tool '${slug}__${toolName}' defined. Bound members pick it up live.`);
}

async function runDefRm(
  args: string[],
  client: Client,
  stdout: (line: string) => void,
): Promise<void> {
  const { positionals } = parseArgs({ args, options: {}, allowPositionals: true });
  const [slug, toolName] = positionals;
  if (!slug || !toolName) {
    throw new UsageError('usage: csuite tools def-rm <slug> <toolName>');
  }
  await client.deleteCustomTool(slug, toolName);
  stdout(`tool '${slug}__${toolName}' removed`);
}

async function runRefresh(
  args: string[],
  client: Client,
  stdout: (line: string) => void,
): Promise<void> {
  const { positionals } = parseArgs({ args, options: {}, allowPositionals: true });
  const slug = requireSlug(positionals);
  const { tools, changed } = await client.refreshToolSource(slug);
  stdout(
    `refreshed '${slug}': ${tools.length} tool(s) discovered${changed ? ' (changed — bound members notified)' : ' (unchanged)'}`,
  );
  for (const t of tools) stdout(`  ${t.name}`);
}
