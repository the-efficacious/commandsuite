// The cannot-publish proof for scripts/release-prepare.mjs
// (obj-mtg8urof-p clause (b)) — trap-first, as the verifier ruled:
// every write-capable executable the script touches is PATH-shimmed
// with a wrapper that logs the invocation, passes read verbs through,
// and hard-fails publish/push/tag-creation/release verbs. The
// assertions are on the trap logs and a recording GitHub stand-in
// (zero non-GET), with refs/tags-unchanged as the secondary check —
// never an inference alone.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'release-prepare.mjs');

const which = (bin) => execFileSync('which', [bin], { encoding: 'utf8' }).trim();

/**
 * A shim: logs every invocation to INVOCATION_LOG, exits 97 on any
 * forbidden verb, otherwise execs the real binary. `guard` is a bash
 * snippet that may call `forbid` after inspecting `$args`.
 */
function writeShim(dir, name, realPath, guard) {
  const lines = [
    '#!/usr/bin/env bash',
    `echo "${name} $*" >> "$INVOCATION_LOG"`,
    `forbid() { echo "FORBIDDEN: ${name} $*" >> "$INVOCATION_LOG"; exit 97; }`,
    'args=" $* "',
    guard,
    `exec "${realPath}" "$@"`,
  ];
  const path = join(dir, name);
  writeFileSync(path, `${lines.join('\n')}\n`);
  chmodSync(path, 0o755);
}

let sandbox;
let shimDir;
let logPath;
let server;
let serverPort;
const serverRequests = [];

function shimEnv() {
  return {
    ...process.env,
    PATH: `${shimDir}:${process.env.PATH}`,
    INVOCATION_LOG: logPath,
    RELEASE_PREPARE_GITHUB_BASE: `http://127.0.0.1:${serverPort}`,
    GITHUB_TOKEN: '',
  };
}

beforeAll(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'release-prepare-test-'));
  shimDir = join(sandbox, 'shims');
  mkdirSync(shimDir);
  logPath = join(sandbox, 'invocations.log');
  writeFileSync(logPath, '');

  // git: pushing anywhere and creating/deleting tags are forbidden;
  // describe/status/log/rev-parse and `tag --list`/-l pass through.
  writeShim(
    shimDir,
    'git',
    which('git'),
    [
      'case "$args" in *" push "*) forbid;; esac',
      'case "$args" in *" tag "*) case "$args" in *" tag --list"*|*" tag -l"*) ;; *) forbid;; esac;; esac',
    ].join('\n'),
  );
  writeShim(shimDir, 'npm', which('npm'), 'case "$args" in *" publish "*) forbid;; esac');
  writeShim(shimDir, 'pnpm', which('pnpm'), 'case "$args" in *" publish "*) forbid;; esac');
  writeShim(
    shimDir,
    'npx',
    which('npx'),
    'case "$args" in *"changeset publish"*|*"changeset version"*) forbid;; esac',
  );
  writeShim(
    shimDir,
    'docker',
    which('docker'),
    'case "$args" in *" push "*|*" login "*) forbid;; esac',
  );
  // The script has no gh call path at all — any invocation is forbidden.
  const ghPath = join(shimDir, 'gh');
  writeFileSync(
    ghPath,
    `#!/usr/bin/env bash\necho "FORBIDDEN: gh $*" >> "$INVOCATION_LOG"\nexit 97\n`,
  );
  chmodSync(ghPath, 0o755);

  // GitHub stand-in: serves the merged-PR set derived from the real
  // manifest (so classification is consistent by construction) and
  // records every request method for the zero-writes assertion.
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, '.release', 'doors.json'), 'utf8'));
  const prs = [
    ...manifest.doors.map((d) => ({ n: d.pr, labels: [{ name: 'door' }] })),
    ...manifest.dismissed.map((d) => ({ n: d.pr, labels: [] })),
  ].map(({ n, labels }) => ({
    number: n,
    title: `pr ${n}`,
    body: '',
    merged_at: '2026-08-30T00:00:00Z',
    updated_at: '2026-08-30T00:00:00Z',
    labels,
  }));
  server = createServer((req, res) => {
    serverRequests.push(`${req.method} ${req.url}`);
    if (req.method !== 'GET') {
      res.statusCode = 405;
      res.end('write refused');
      return;
    }
    const page = Number(new URL(req.url, 'http://x').searchParams.get('page') ?? '1');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(page === 1 ? prs : []));
  });
  await new Promise((res) => {
    server.listen(0, '127.0.0.1', res);
  });
  serverPort = server.address().port;
});

afterAll(() => {
  server?.close();
  rmSync(sandbox, { recursive: true, force: true });
});

describe('release-prepare cannot publish', () => {
  it('positive control: the traps actually trap forbidden verbs', () => {
    for (const [bin, argv] of [
      ['git', ['push', 'origin', 'main']],
      ['git', ['tag', 'v9.9.9']],
      ['npm', ['publish']],
      ['docker', ['push', 'example/image']],
      ['gh', ['release', 'create', 'v9.9.9']],
    ]) {
      const run = spawnSync(join(shimDir, bin), argv, { env: shimEnv(), encoding: 'utf8' });
      expect(run.status, `${bin} ${argv.join(' ')} must be trapped`).toBe(97);
    }
    // Read forms pass through the same shims.
    const list = spawnSync(join(shimDir, 'git'), ['tag', '--list'], {
      cwd: REPO_ROOT,
      env: shimEnv(),
      encoding: 'utf8',
    });
    expect(list.status).toBe(0);
    writeFileSync(logPath, ''); // reset for the real run's assertions
  });

  it('runs preparation with real builds under traps: zero write invocations, refs and tags unchanged', async () => {
    const refsBefore = execFileSync('git', ['for-each-ref'], { cwd: REPO_ROOT, encoding: 'utf8' });
    const tagsBefore = execFileSync('git', ['tag', '--list'], { cwd: REPO_ROOT, encoding: 'utf8' });
    const outPath = join(sandbox, 'RELEASE-test.md');

    // spawn (not spawnSync): the fixture server lives in this process,
    // so blocking the event loop would deadlock the script's fetch.
    const run = await new Promise((resolvePromise) => {
      const child = spawn(
        process.execPath,
        [
          SCRIPT,
          '--allow-dirty',
          '--skip-image',
          '--gate',
          'none',
          '--allow-incomplete',
          '--out',
          outPath,
        ],
        { cwd: REPO_ROOT, env: shimEnv() },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
    });
    expect(run.stderr).not.toContain('FORBIDDEN');
    expect(run.status, `script failed:\n${run.stdout}\n${run.stderr}`).toBe(0);

    const log = readFileSync(logPath, 'utf8');
    // Trap-first: the log shows real read/build activity and zero
    // forbidden verbs — the property holds at the executable level.
    expect(log).toContain('git status --porcelain');
    expect(log).toContain('pnpm build');
    expect(log).toContain('npm pack');
    expect(log).not.toContain('FORBIDDEN');
    expect(log).not.toMatch(/\bgh\b/);
    expect(log).not.toMatch(/npm publish|pnpm publish|docker push|git push/);

    // The GitHub stand-in saw only reads.
    expect(serverRequests.length).toBeGreaterThan(0);
    expect(serverRequests.every((r) => r.startsWith('GET '))).toBe(true);

    // Secondary: repository refs and tags byte-identical.
    const refsAfter = execFileSync('git', ['for-each-ref'], { cwd: REPO_ROOT, encoding: 'utf8' });
    const tagsAfter = execFileSync('git', ['tag', '--list'], { cwd: REPO_ROOT, encoding: 'utf8' });
    expect(refsAfter).toBe(refsBefore);
    expect(tagsAfter).toBe(tagsBefore);

    // The diagnostic render is visibly non-signable and carries the facts.
    const rendered = readFileSync(outPath, 'utf8');
    expect(rendered).toContain('INCOMPLETE — NOT SIGNABLE');
    expect(rendered).not.toContain('- Lea: ___');
    expect(rendered).toContain('## Read these');
    expect(rendered).toContain('## Proposed version');
  }, 600_000);
});
