#!/usr/bin/env node
// Seed a bootstrapped broker with one real instance for every
// parametrised route in the manifest, enrol web-UI TOTP for the two
// walking roles, and write the fixtures file walk.mjs fills URL
// templates from (obj-mtg1kwxb-m; the #220 seed recipe as a script).
//
// Usage: node seed.mjs --broker <url> --admin-token-file <path>
//                      --baseline <member> --out <dir> [--csuite <bin>]
//
// Everything runs as the admin over the product's own surfaces: CLI
// verbs where they exist, REST for TOTP enrolment. TOTP secrets land
// in <out>/totp-<member>.secret at 0600; fixtures in <out>/fixtures.json.
// Idempotent: reruns tolerate already-exists responses.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--'))
      acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
    return acc;
  }, []),
);
for (const k of ['broker', 'admin-token-file', 'baseline', 'out']) {
  if (!args[k]) {
    console.error(`seed.mjs: --${k} is required`);
    process.exit(2);
  }
}
const BROKER = String(args.broker).replace(/\/+$/, '');
const BASELINE = String(args.baseline);
const OUT = String(args.out);
const CSUITE = String(args.csuite ?? 'csuite').split(' ');
const token = readFileSync(String(args['admin-token-file']), 'utf8').trim();
mkdirSync(OUT, { recursive: true });

const env = { ...process.env, CSUITE_URL: BROKER, CSUITE_TOKEN: token };

/** Run a csuite verb as admin; tolerate already-exists (idempotent seeding). */
function cli(...argv) {
  try {
    return execFileSync(CSUITE[0], [...CSUITE.slice(1), ...argv], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const text = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    if (/already|exists|duplicate/i.test(text)) return text;
    throw new Error(`seed.mjs: csuite ${argv.join(' ')} failed: ${text.trim()}`);
  }
}

async function rest(method, path, body) {
  const res = await fetch(`${BROKER}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok && !/already|exists|duplicate/i.test(text)) {
    throw new Error(`seed.mjs: ${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

// ── Fixtures, one per manifest placeholder. ─────────────────────────
const fixtures = {
  channelSlug: 'walk-channel',
  dmPeer: 'admin',
  objectiveId: null, // filled below
  toolSourceSlug: 'walk-tool',
  secretSlug: 'walk-secret',
  variableSlug: 'walk-var',
  notificationSlug: 'walk-hook',
};

// Channel the baseline member belongs to (REST — channels have no CLI verb).
await rest('POST', '/channels', { slug: fixtures.channelSlug });
await rest('POST', `/channels/${fixtures.channelSlug}/members`, { member: BASELINE });
await rest('POST', `/channels/${fixtures.channelSlug}/members`, { member: 'admin' });

// DM thread with the admin (a message creates the thread).
cli('push', '--agent', BASELINE, '--body', 'route-walk seed: DM fixture');

// Objective assigned to the baseline member.
const objectiveOut = cli(
  'objectives',
  'create',
  '--title',
  'Route walk fixture objective',
  '--outcome',
  'Exists so /objectives/{id} renders with a real instance for the route walk.',
  '--assignee',
  BASELINE,
);
fixtures.objectiveId = /obj-[a-z0-9-]+/.exec(objectiveOut)?.[0] ?? null;
if (!fixtures.objectiveId) {
  throw new Error(`seed.mjs: objective creation printed no id: ${objectiveOut.trim()}`);
}

// Tool source, secret and variable (bound to the baseline member),
// notification endpoint.
cli('tools', 'add', fixtures.toolSourceSlug, '--kind', 'custom', '--name', 'Route walk tool');
cli('secrets', 'add', fixtures.secretSlug, '--env', 'WALK_SECRET');
cli('secrets', 'bind', fixtures.secretSlug, BASELINE);
cli('variables', 'add', fixtures.variableSlug, '--env', 'WALK_VAR');
cli('variables', 'bind', fixtures.variableSlug, BASELINE);
cli('notifications', 'add', fixtures.notificationSlug, '--target', `@${BASELINE}`);

// A file in the baseline member's home so /files/{selfName} lists real
// content (fs write as admin into the member's home requires
// members.manage — admin holds it).
await rest(
  'POST',
  `/fs/write?path=/${encodeURIComponent(BASELINE)}/route-walk.txt&mime=text/plain&collide=overwrite`,
  undefined,
).catch(() => {});

// ── Web-UI TOTP for both walking roles (REST enrolment as admin). ──
for (const member of [BASELINE, 'admin']) {
  const enrolled = await rest('POST', `/members/${encodeURIComponent(member)}/enroll-totp`, {});
  const secret = enrolled?.secret ?? enrolled?.totpSecret;
  if (!secret) throw new Error(`seed.mjs: TOTP enrolment for ${member} returned no secret`);
  const file = `${OUT}/totp-${member}.secret`;
  writeFileSync(file, `${secret}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  console.log(`totp secret for ${member}: ${file} (0600)`);
}

writeFileSync(`${OUT}/fixtures.json`, `${JSON.stringify(fixtures, null, 2)}\n`);
console.log(`fixtures: ${OUT}/fixtures.json`);
console.log(JSON.stringify(fixtures));
