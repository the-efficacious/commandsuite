#!/usr/bin/env node
// Render everything the two humans need to decide a release — and
// publish nothing (obj-mtg8urof-p).
//
// From a clean main checkout this script:
//   1. collects every changeset since the last tag and the proposed
//      version by semver rule (the changesets tooling's own answer);
//   2. renders the "read these" section from the door manifest
//      (.release/doors.json) — the completeness contract: every PR
//      merged since the tag must be classified there, every door must
//      carry the `door` label, and a phrase tripwire flags candidates
//      the manifest missed. Any disagreement fails loud;
//   3. builds the CLI and SDK packages (npm pack) and the container
//      image locally, recording sizes, sha256 hashes, and the source
//      fingerprint (scripts/source-fingerprint.mjs);
//   4. runs the full gate — unit, stub conformance, bootstrap,
//      compose, service, route-walk — each row backed by the captured
//      exit status and a log file, never a summary;
//   5. renders RELEASE-<version>.md with every fact above and two
//      empty signature lines (Lea, Andrew).
//
// It REFUSES to publish: there is no call path that tags, pushes, or
// publishes, and scripts/test/release-prepare.test.mjs proves it with
// executable-level write traps. The only side effects are the rendered
// file, local build artefacts, and logs under .release/prepare-logs/.
//
// The rendered file is signable ONLY when every gate ran and passed.
// A host that cannot run a gate fails preparation; --allow-incomplete
// renders the skips for local diagnosis but replaces the signature
// block with an INCOMPLETE — NOT SIGNABLE banner. The nightly workflow
// runs the complete form.
//
// Flags: --out <path>   (default RELEASE-<version>.md in the repo root)
//        --allow-dirty  (skip the clean-tree check; dev only)
//        --allow-incomplete  (render skips; output is not signable)
//        --skip-build --skip-image --gate none  (test/diagnostic use;
//          all three force the NOT SIGNABLE banner)
//
// Needs no credential. GitHub PR metadata is read unauthenticated
// (GITHUB_TOKEN is used for rate limits when present); if the read
// fails, the run fails causally rather than rendering a plausible
// blank. RELEASE_PREPARE_GITHUB_BASE overrides the API base (tests).
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = 'the-efficacious';
const REPO = 'commandsuite';
// biome-ignore lint/suspicious/noUndeclaredEnvVars: test-only override, documented in the header
const GITHUB_BASE = process.env.RELEASE_PREPARE_GITHUB_BASE ?? 'https://api.github.com';
const DOOR_TRIPWIRE =
  /\bdoor\b|surfac(?:ed|ing)|additive (?:header|endpoint|field|wire)|public surface/i;

const args = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')));
const argValue = (flag) => {
  const index = process.argv.indexOf(flag);
  return index !== -1 ? process.argv[index + 1] : undefined;
};
const allowDirty = args.has('--allow-dirty');
const allowIncomplete = args.has('--allow-incomplete');
const skipBuild = args.has('--skip-build');
const skipImage = args.has('--skip-image');
const gateMode = argValue('--gate') ?? 'full';

const problems = []; // fatal fact-collection failures
const holds = []; // unresolved classifications — rendered AND nonzero exit
const notes = []; // deliberate diagnostic gaps (skip flags) — non-signable, exit 0

function git(...argv) {
  return execFileSync('git', argv, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function human(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

// ── 0. Clean tree ───────────────────────────────────────────────────
const dirty = git('status', '--porcelain');
if (dirty !== '' && !allowDirty) {
  console.error(
    'release-prepare: working tree is not clean — a release derives from committed state.',
  );
  console.error(dirty);
  console.error('  (--allow-dirty for local diagnosis; the output will not be signable)');
  process.exit(2);
}

const lastTag = git('describe', '--tags', '--abbrev=0');
const tagDate = git('log', '-1', '--format=%cI', lastTag);
const headSha = git('rev-parse', 'HEAD');

// ── 1. Changesets + proposed version ────────────────────────────────
const logDir = join(REPO_ROOT, '.release', 'prepare-logs');
mkdirSync(logDir, { recursive: true });
const statusPath = join(logDir, 'changeset-status.json');
execFileSync('npx', ['changeset', 'status', '--output', statusPath], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});
const changesetStatus = JSON.parse(readFileSync(statusPath, 'utf8'));
const releases = changesetStatus.releases ?? [];
const version =
  releases.find((r) => r.name === 'csuite')?.newVersion ?? releases[0]?.newVersion ?? null;
if (version === null) problems.push('changesets propose no release — nothing to prepare');

const changesetEntries = [];
for (const file of readdirSync(join(REPO_ROOT, '.changeset')).sort()) {
  if (!file.endsWith('.md') || file === 'README.md') continue;
  const raw = readFileSync(join(REPO_ROOT, '.changeset', file), 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!match) {
    problems.push(`changeset ${file} has no frontmatter — cannot render`);
    continue;
  }
  changesetEntries.push({
    file,
    packages: [...match[1].matchAll(/^['"]?([^'":\n]+)['"]?:\s*(\w+)/gm)].map(
      ([, name, bump]) => `${name.trim()} (${bump})`,
    ),
    summary: match[2].trim(),
  });
}

// ── 2. Doors: manifest ↔ merged PRs ↔ labels ↔ tripwire ─────────────
async function fetchMergedSince(sinceIso) {
  const headers = { accept: 'application/vnd.github+json' };
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: optional rate-limit credential, never required
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  const merged = [];
  for (let page = 1; page <= 10; page += 1) {
    const url = `${GITHUB_BASE}/repos/${OWNER}/${REPO}/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=100&page=${page}`;
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      throw new Error(
        `GitHub read failed: GET ${url} -> ${response.status} ${await response.text().then((t) => t.slice(0, 200))}`,
      );
    }
    const batch = await response.json();
    if (batch.length === 0) break;
    for (const pr of batch) {
      if (pr.merged_at && pr.merged_at > sinceIso) {
        merged.push({
          number: pr.number,
          title: pr.title,
          body: pr.body ?? '',
          mergedAt: pr.merged_at,
          labels: (pr.labels ?? []).map((l) => l.name),
        });
      }
    }
    if (batch.every((pr) => pr.updated_at < sinceIso)) break;
  }
  return merged.sort((a, b) => a.number - b.number);
}

const manifestPath = argValue('--manifest') ?? join(REPO_ROOT, '.release', 'doors.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
// Schema safety BEFORE the maps: Maps silently collapse duplicates,
// and the manifest's contract is "exactly one classification per PR".
{
  const doorPrs = manifest.doors.map((d) => d.pr);
  const dismissedPrs = manifest.dismissed.map((d) => d.pr);
  for (const [label, list] of [
    ['doors', doorPrs],
    ['dismissed', dismissedPrs],
  ]) {
    const dupes = list.filter((pr, i) => list.indexOf(pr) !== i);
    if (dupes.length > 0)
      problems.push(`manifest ${label} lists duplicate PR(s): ${[...new Set(dupes)].join(', ')}`);
  }
  const overlap = doorPrs.filter((pr) => dismissedPrs.includes(pr));
  if (overlap.length > 0) {
    problems.push(`manifest classifies PR(s) as BOTH door and dismissed: ${overlap.join(', ')}`);
  }
}
const doorByPr = new Map(manifest.doors.map((d) => [d.pr, d]));
const dismissedByPr = new Map(manifest.dismissed.map((d) => [d.pr, d]));

let mergedPrs = [];
try {
  mergedPrs = await fetchMergedSince(tagDate);
} catch (err) {
  problems.push(err instanceof Error ? err.message : String(err));
}
const mergedByPr = new Map(mergedPrs.map((pr) => [pr.number, pr]));

for (const pr of mergedPrs) {
  if (!doorByPr.has(pr.number) && !dismissedByPr.has(pr.number)) {
    problems.push(
      `PR #${pr.number} ("${pr.title}") merged since ${lastTag} is not classified in .release/doors.json`,
    );
  }
  if (pr.labels.includes('door') && !doorByPr.has(pr.number)) {
    problems.push(`PR #${pr.number} carries the door label but is not in the manifest's doors`);
  }
}
for (const door of manifest.doors) {
  const pr = mergedByPr.get(door.pr);
  if (pr === undefined) {
    problems.push(`manifest door PR #${door.pr} is not merged to main since ${lastTag}`);
    continue;
  }
  if (!pr.labels.includes('door')) {
    problems.push(`manifest door PR #${door.pr} is missing the door label on GitHub`);
  }
}
for (const dismissed of manifest.dismissed) {
  if (/held for ruling/i.test(dismissed.reason)) {
    holds.push(`PR #${dismissed.pr}: ${dismissed.reason}`);
  }
  const pr = mergedByPr.get(dismissed.pr);
  if (mergedPrs.length > 0 && pr === undefined) {
    problems.push(
      `manifest dismisses PR #${dismissed.pr} which is not merged to main since ${lastTag} — stale row`,
    );
  }
  const cited = /held for ruling|not a door per|discoverer's classification|ruled dismissed/i.test(
    dismissed.reason,
  );
  if (pr && DOOR_TRIPWIRE.test(`${pr.title}\n${pr.body}`) && !cited) {
    holds.push(
      `PR #${dismissed.pr} ("${pr.title}") matches the door tripwire but its dismissal cites no ruling — dismiss with a source or move it to doors`,
    );
  }
}

// ── 3. Artefacts ────────────────────────────────────────────────────
const artefacts = [];
let fingerprint = null;
if (!skipBuild) {
  execFileSync('pnpm', ['build'], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const pkg of ['packages/cli', 'packages/sdk']) {
    const out = execFileSync('npm', ['pack', '--json'], {
      cwd: join(REPO_ROOT, pkg),
      encoding: 'utf8',
    });
    const [info] = JSON.parse(out);
    const tarball = join(REPO_ROOT, pkg, info.filename);
    artefacts.push({
      name: info.filename,
      size: statSync(tarball).size,
      sha256: sha256(tarball),
    });
  }
  const { sourceFingerprint } = await import('./source-fingerprint.mjs');
  fingerprint = sourceFingerprint(REPO_ROOT);
} else {
  notes.push('builds skipped (--skip-build) — artefact facts absent');
}
if (!skipImage && !skipBuild) {
  const tag = `csuite-release-prepare:${version ?? 'unversioned'}`;
  const build = spawnSync('docker', ['build', '-q', '-t', tag, '.'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (build.status !== 0) {
    problems.push(`container image build failed: ${build.stderr.slice(0, 300)}`);
  } else {
    const imageId = build.stdout.trim();
    const size = execFileSync('docker', ['image', 'inspect', '--format', '{{.Size}}', imageId], {
      encoding: 'utf8',
    }).trim();
    artefacts.push({ name: `container ${tag}`, size: Number(size), sha256: imageId });
  }
} else if (!skipBuild) {
  notes.push('container image skipped (--skip-image) — image facts absent');
}

// ── 4. The gate ─────────────────────────────────────────────────────
const GATE_PORT = 8731;
const gateJobs = [
  { name: 'unit', command: ['pnpm', 'test'], cwd: REPO_ROOT },
  {
    name: 'conformance (stub)',
    command: ['npx', 'vitest', 'run', 'test/runtime/conformance'],
    cwd: join(REPO_ROOT, 'packages/cli'),
  },
  {
    name: 'bootstrap',
    command: [
      'bash',
      '-c',
      `CSUITE_BOOTSTRAP_DIR="$LOGDIR/bootstrap-fixture" CSUITE_AUTH_CONFIG_PATH="$LOGDIR/bootstrap-fixture/auth.json" CSUITE_PORT=${GATE_PORT} CSUITE_RUNNER_VERB=stub CSUITE_START_RUNNER=1 scripts/bootstrap.sh up </dev/null && CSUITE_BOOTSTRAP_DIR="$LOGDIR/bootstrap-fixture" CSUITE_AUTH_CONFIG_PATH="$LOGDIR/bootstrap-fixture/auth.json" CSUITE_PORT=${GATE_PORT} scripts/bootstrap.sh verify </dev/null; code=$?; CSUITE_BOOTSTRAP_DIR="$LOGDIR/bootstrap-fixture" scripts/bootstrap.sh down; exit $code`,
    ],
    cwd: REPO_ROOT,
  },
  {
    name: 'compose',
    command: ['bash', 'scripts/compose-check.sh'],
    cwd: REPO_ROOT,
    capability: () =>
      spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0
        ? null
        : 'docker daemon unavailable',
  },
  {
    name: 'service',
    command: ['bash', 'scripts/service-check.sh'],
    cwd: REPO_ROOT,
    capability: () => {
      if (spawnSync('systemctl', ['--version'], { stdio: 'ignore' }).status !== 0)
        return 'systemd unavailable';
      if (spawnSync('sudo', ['-n', 'true'], { stdio: 'ignore' }).status !== 0)
        return 'no passwordless sudo';
      const unit = `csuite-${execFileSync('id', ['-un'], { encoding: 'utf8' }).trim()}`;
      if (
        spawnSync('systemctl', ['is-active', '--quiet', unit], { stdio: 'ignore' }).status === 0
      ) {
        return `unit ${unit} is a live seat on this host — the install/teardown cycle must not touch it`;
      }
      return null;
    },
  },
  {
    name: 'route-walk',
    command: [
      'bash',
      '-c',
      `set -e; D="$LOGDIR/walk-fixture"; CSUITE_BOOTSTRAP_DIR="$D" CSUITE_AUTH_CONFIG_PATH="$D/auth.json" CSUITE_PORT=${GATE_PORT + 1} CSUITE_RUNNER_VERB=stub CSUITE_START_RUNNER=1 scripts/bootstrap.sh up </dev/null; trap 'CSUITE_BOOTSTRAP_DIR="$D" scripts/bootstrap.sh down' EXIT; node scripts/route-walk/seed.mjs --broker http://127.0.0.1:${GATE_PORT + 1} --admin-token-file "$D/secrets/admin.token" --baseline builder --csuite "node $PWD/packages/cli/dist/index.js" --out "$D/walk"; node scripts/route-walk/walk.mjs --broker http://127.0.0.1:${GATE_PORT + 1} --member builder --role baseline --secret "$D/walk/totp-builder.secret" --fixtures "$D/walk/fixtures.json" --out "$D/walk"; node scripts/route-walk/walk.mjs --broker http://127.0.0.1:${GATE_PORT + 1} --member admin --role admin --secret "$D/walk/totp-admin.secret" --fixtures "$D/walk/fixtures.json" --out "$D/walk"`,
    ],
    cwd: REPO_ROOT,
    capability: () => {
      // biome-ignore lint/suspicious/noUndeclaredEnvVars: operator override, documented in docs/dev/route-walk.mdx
      const chromium = process.env.CHROMIUM ?? '/usr/bin/chromium';
      return spawnSync(chromium, ['--version'], { stdio: 'ignore' }).status === 0
        ? null
        : `no Chromium-family binary at ${chromium} (set CHROMIUM)`;
    },
  },
];

if (allowDirty) {
  notes.push(
    dirty === ''
      ? 'run with --allow-dirty — not signable regardless of tree state'
      : 'dirty tree (--allow-dirty) — this render derives from uncommitted state',
  );
}

const gateRows = [];
if (gateMode === 'none') {
  notes.push('gate skipped (--gate none) — no gate facts');
} else {
  for (const job of gateJobs) {
    const reason = job.capability?.() ?? null;
    const logPath = join(logDir, `${job.name.replace(/[^a-z-]+/gi, '-')}.log`);
    if (reason !== null) {
      gateRows.push({
        name: job.name,
        command: job.command.join(' '),
        status: 'SKIPPED',
        reason,
        logPath: null,
        durationMs: 0,
      });
      continue;
    }
    const started = Date.now();
    const run = spawnSync(job.command[0], job.command.slice(1), {
      cwd: job.cwd,
      encoding: 'utf8',
      env: { ...process.env, LOGDIR: logDir },
      maxBuffer: 64 * 1024 * 1024,
    });
    writeFileSync(
      logPath,
      `$ ${job.command.join(' ')}\n\n${run.stdout ?? ''}\n${run.stderr ?? ''}\n\nexit: ${run.status}\n`,
    );
    gateRows.push({
      name: job.name,
      command: job.command.join(' '),
      status: run.status === 0 ? 'PASS' : 'FAIL',
      exitCode: run.status,
      logPath,
      durationMs: Date.now() - started,
    });
  }
}
const gateSkips = gateRows.filter((row) => row.status === 'SKIPPED');
const gateFails = gateRows.filter((row) => row.status === 'FAIL');
if (gateSkips.length > 0 && !allowIncomplete) {
  problems.push(
    `full gate required but ${gateSkips.length} job(s) cannot run here: ${gateSkips.map((s) => `${s.name} (${s.reason})`).join('; ')} — run on a capable host or pass --allow-incomplete for a non-signable diagnostic render`,
  );
}

// ── 5. Render ───────────────────────────────────────────────────────
const incomplete = gateMode === 'none' || skipBuild || gateSkips.length > 0 || problems.length > 0;
const signable = !incomplete && gateFails.length === 0 && holds.length === 0;
const outPath = resolve(
  argValue('--out') ?? join(REPO_ROOT, `RELEASE-${version ?? 'unversioned'}.md`),
);

const lines = [];
lines.push(`# Release ${version ?? '(no version proposed)'} — preparation record`);
lines.push('');
lines.push(
  `- prepared from: \`${headSha}\` (${git('branch', '--show-current') || 'detached'}), previous tag \`${lastTag}\` (${tagDate})`,
);
lines.push(`- prepared at: ${new Date().toISOString()}`);
if (fingerprint !== null) lines.push(`- source fingerprint: \`${fingerprint}\``);
lines.push('');
if (problems.length > 0) {
  lines.push('## PREPARATION FAILED — facts below are incomplete');
  for (const problem of problems) lines.push(`- ${problem}`);
  lines.push('');
}
if (holds.length > 0) {
  lines.push('## HOLDS — resolve before signing (preparation exits nonzero)');
  for (const hold of holds) lines.push(`- ${hold}`);
  lines.push('');
}
if (notes.length > 0) {
  lines.push('## DIAGNOSTIC GAPS — this render is not signable');
  for (const note of notes) lines.push(`- ${note}`);
  lines.push('');
}
lines.push(`## Proposed version: ${version ?? 'n/a'}`);
lines.push('');
for (const release of releases) {
  lines.push(`- ${release.name}: ${release.oldVersion} → ${release.newVersion} (${release.type})`);
}
lines.push('');
lines.push(`## Changelog entries (${changesetEntries.length} changesets)`);
lines.push('');
for (const entry of changesetEntries) {
  lines.push(`### ${entry.file} — ${entry.packages.join(', ')}`);
  lines.push('');
  lines.push(entry.summary);
  lines.push('');
}
lines.push(`## Read these — surfaced doors since ${lastTag} (${manifest.doors.length})`);
lines.push('');
lines.push(
  'The input to the human gate: every PR that landed a surfaced door, from the checked-in manifest `.release/doors.json`, cross-checked against merged PRs and the `door` label.',
);
lines.push('');
for (const door of manifest.doors) {
  const pr = mergedByPr.get(door.pr);
  lines.push(
    `- [#${door.pr}](https://github.com/${OWNER}/${REPO}/pull/${door.pr}) ${pr ? `**${pr.title}**` : '(NOT FOUND IN RANGE)'} — ${door.ruling}`,
  );
}
lines.push('');
lines.push('## Artefacts');
lines.push('');
if (artefacts.length === 0) lines.push('- (none built this run)');
for (const artefact of artefacts) {
  lines.push(`- ${artefact.name} — ${human(artefact.size)} — \`${artefact.sha256}\``);
}
lines.push('');
lines.push('## Gate');
lines.push('');
lines.push('| job | result | detail | duration | log |');
lines.push('| --- | --- | --- | --- | --- |');
for (const row of gateRows) {
  lines.push(
    `| ${row.name} | ${row.status} | ${row.reason ?? ''} | ${(row.durationMs / 1000).toFixed(0)}s | ${row.logPath ? row.logPath.replace(`${REPO_ROOT}/`, '') : '—'} |`,
  );
}
if (gateRows.length === 0) lines.push('| (gate not run) | — | — | — | — |');
lines.push('');
if (signable) {
  lines.push('## Signatures');
  lines.push('');
  lines.push('The undersigned read the doors above and accept this release.');
  lines.push('');
  lines.push('- Lea: ______________________  date: __________');
  lines.push('- Andrew: ___________________  date: __________');
} else {
  lines.push('## INCOMPLETE — NOT SIGNABLE');
  lines.push('');
  lines.push(
    'This render is a diagnostic. It is missing facts (see holds/failures above) or a gate did not pass; it must not be signed and must not be the nightly artifact.',
  );
}
lines.push('');
writeFileSync(outPath, `${lines.join('\n')}\n`);

console.log(`rendered ${outPath}${signable ? ' (signable)' : ' (NOT SIGNABLE)'}`);
for (const problem of problems) console.error(`problem: ${problem}`);
for (const hold of holds) console.error(`hold: ${hold}`);
for (const note of notes) console.error(`note: ${note}`);
process.exit(problems.length > 0 || gateFails.length > 0 || holds.length > 0 ? 1 : 0);
