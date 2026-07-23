/**
 * `csuite <runner> --doctor` — preflight checks for any agent runner.
 *
 * The doctor is adapter-generic: every runner gets the same shared
 * checks, plus whatever the adapter declares. The check list mirrors
 * what the runner and capture host actually need at runtime:
 *
 *   1. Agent binary present (adapter `locate()` — PATH or env override)
 *   2. Agent version detected, WARNed when outside the adapter's
 *      declared tested range (`meta.testedVersions`) — advisory only,
 *      agents move fast and untested ≠ broken
 *   3. `$TMPDIR` writable — scratch space for the runner
 *   4. Can bind a loopback TCP listener — for the hook server the
 *      capture host owns
 *   5. Any adapter-specific checks (`adapter.doctor()`)
 *
 * The doctor never reaches out to a broker or spawns an agent session;
 * it's a local check the member runs before their first
 * `csuite <runner>` invocation. The runners also run it silently as a
 * default preflight (version probe skipped for startup latency);
 * `--skip-doctor` opts out.
 *
 * Output is plain text — one check per line, each prefixed with its
 * status marker. Exit code 0 if everything PASSes, 1 if any check
 * FAILs. WARNs don't fail the exit code; they're advisory.
 */

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AgentAdapter, TestedVersionRange } from '../runtime/agents/adapter.js';
import { AgentAdapterError } from '../runtime/agents/adapter.js';
import { createClaudeAdapter } from '../runtime/agents/claude-agent.js';

const execFileAsync = promisify(execFile);

export type CheckStatus = 'PASS' | 'WARN' | 'FAIL';

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  anyFail: boolean;
}

export interface AgentDoctorOptions {
  /**
   * Probe the agent's version (`<binary> <meta.versionArgs>`) and
   * compare against the adapter's declared tested range. Default true.
   * The silent pre-session preflight passes false — spawning the agent
   * binary just to read a version adds real latency to every start.
   */
  includeVersion?: boolean;
}

/** Run the shared + adapter-specific preflight checks for one runner. */
export async function runAgentDoctor(
  adapter: AgentAdapter,
  options: AgentDoctorOptions = {},
): Promise<DoctorReport> {
  const meta = adapter.meta;
  const checks: DoctorCheck[] = [];

  // 1. Agent binary. locate() is contractually side-effect free.
  let binaryFound = false;
  try {
    await adapter.locate();
    binaryFound = true;
    checks.push({
      name: `${meta.id} binary`,
      status: 'PASS',
      detail: adapter.binaryPath?.() ?? 'found',
    });
  } catch (err) {
    checks.push({
      name: `${meta.id} binary`,
      status: 'FAIL',
      detail: err instanceof AgentAdapterError || err instanceof Error ? err.message : String(err),
    });
  }

  // 2. Agent version vs declared tested range. Advisory: WARN, never FAIL.
  if (binaryFound && meta.versionArgs !== null && options.includeVersion !== false) {
    const binary = adapter.binaryPath?.();
    if (binary) {
      checks.push(await checkAgentVersion(meta.id, binary, meta.versionArgs, meta.testedVersions));
    }
  }

  checks.push(await checkTmpdir());
  checks.push(await checkLoopbackBind());

  if (adapter.doctor) {
    try {
      checks.push(...(await adapter.doctor()));
    } catch (err) {
      checks.push({
        name: `${meta.id} adapter checks`,
        status: 'WARN',
        detail: `adapter doctor() threw: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return { checks, anyFail: checks.some((c) => c.status === 'FAIL') };
}

/**
 * Back-compat entry point: the claude doctor. `csuite claude
 * --doctor` and existing callers keep working unchanged.
 */
export async function runDoctor(): Promise<DoctorReport> {
  return runAgentDoctor(createClaudeAdapter({ claudeArgs: [] }));
}

async function checkAgentVersion(
  id: string,
  binary: string,
  versionArgs: readonly string[],
  range: TestedVersionRange | null,
): Promise<DoctorCheck> {
  const name = `${id} version`;
  let output: string;
  try {
    const { stdout, stderr } = await execFileAsync(binary, [...versionArgs], {
      timeout: 5000,
      encoding: 'utf8',
    });
    output = `${stdout}\n${stderr}`;
  } catch (err) {
    return {
      name,
      status: 'WARN',
      detail: `could not run ${binary} ${versionArgs.join(' ')}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  const detected = extractVersion(output);
  if (detected === null) {
    return { name, status: 'WARN', detail: 'could not parse a version from the output' };
  }
  if (range === null || (range.min === undefined && range.max === undefined)) {
    return { name, status: 'PASS', detail: `${detected} (adapter declares no tested range)` };
  }
  const rangeText = [
    range.min !== undefined ? `>=${range.min}` : null,
    range.max !== undefined ? `<=${range.max}` : null,
  ]
    .filter((s) => s !== null)
    .join(' ');
  const belowMin = range.min !== undefined && compareVersions(detected, range.min) < 0;
  const aboveMax = range.max !== undefined && compareVersions(detected, range.max) > 0;
  if (belowMin || aboveMax) {
    return {
      name,
      status: 'WARN',
      detail: `${detected} is outside the tested range ${rangeText} — proceed with care`,
    };
  }
  return { name, status: 'PASS', detail: `${detected} (tested range ${rangeText})` };
}

/** First semver-looking triple in the version output. */
export function extractVersion(output: string): string | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(output);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

/** Segment-wise numeric compare of `a.b.c` triples. -1 / 0 / 1. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10));
  const pb = b.split('.').map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da < db ? -1 : 1;
  }
  return 0;
}

async function checkTmpdir(): Promise<DoctorCheck> {
  const dir = tmpdir();
  const probePath = join(dir, `csuite-doctor-${randomBytes(4).toString('hex')}`);
  try {
    await fs.writeFile(probePath, 'ok', { mode: 0o600 });
    await fs.unlink(probePath);
    return { name: '$TMPDIR writable', status: 'PASS', detail: dir };
  } catch (err) {
    return {
      name: '$TMPDIR writable',
      status: 'FAIL',
      detail: `${dir}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function checkLoopbackBind(): Promise<DoctorCheck> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('listening', () => {
      const addr = server.address();
      server.close(() => {
        if (addr && typeof addr !== 'string') {
          resolve({
            name: 'loopback hook server bindable',
            status: 'PASS',
            detail: `bound ephemeral on 127.0.0.1:${addr.port}`,
          });
        } else {
          resolve({
            name: 'loopback hook server bindable',
            status: 'FAIL',
            detail: 'unexpected address shape after bind',
          });
        }
      });
    });
    server.once('error', (err) => {
      resolve({
        name: 'loopback hook server bindable',
        status: 'FAIL',
        detail: err instanceof Error ? err.message : String(err),
      });
    });
    server.listen(0, '127.0.0.1');
  });
}

/** Format a report for human-readable stdout. */
export function formatReport(report: DoctorReport): string {
  const lines: string[] = [];
  for (const check of report.checks) {
    lines.push(`  [${check.status}] ${check.name} — ${check.detail}`);
  }
  lines.push('');
  lines.push(report.anyFail ? 'doctor: FAIL' : 'doctor: OK');
  return lines.join('\n');
}
