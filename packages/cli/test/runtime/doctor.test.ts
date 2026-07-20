/**
 * Doctor unit tests — we exercise the high-level report shape
 * rather than every individual check. The individual checks
 * (claude binary, tmpdir, loopback bind) have their own failure
 * paths covered elsewhere; here we just prove the overall runner
 * wires them together, formats them readably, and sets `anyFail`
 * correctly when any check fails.
 *
 * We mask out CLAUDE_PATH to force the claude check into its
 * failure path (assuming there's no global `claude` binary on the
 * box — this is true in CI). The tmpdir + loopback checks are
 * expected to PASS on any reasonable dev environment.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatReport, runDoctor } from '../../src/commands/doctor.js';

describe('runDoctor', () => {
  let savedClaudePath: string | undefined;

  beforeEach(() => {
    savedClaudePath = process.env.CLAUDE_PATH;
    delete process.env.CLAUDE_PATH;
  });

  afterEach(() => {
    if (savedClaudePath === undefined) delete process.env.CLAUDE_PATH;
    else process.env.CLAUDE_PATH = savedClaudePath;
  });

  it('returns a check for every category', async () => {
    const report = await runDoctor();
    const names = report.checks.map((c) => c.name);
    expect(names).toContain('$TMPDIR writable');
    expect(names).toContain('loopback hook server bindable');
    expect(names.some((n) => n.includes('claude'))).toBe(true);
  });

  it('sets anyFail true when a required check fails', async () => {
    process.env.CLAUDE_PATH = '/nonexistent/claude-binary';
    const report = await runDoctor();
    const claude = report.checks.find((c) => c.name.includes('claude'));
    expect(claude?.status).toBe('FAIL');
    expect(report.anyFail).toBe(true);
  });

  it('loopback bind check passes on a normal dev environment', async () => {
    const report = await runDoctor();
    const bind = report.checks.find((c) => c.name.includes('loopback'));
    expect(bind?.status).toBe('PASS');
  });

  it('formatReport produces human-readable output', async () => {
    const report = await runDoctor();
    const text = formatReport(report);
    expect(text).toMatch(/\[(PASS|WARN|FAIL)\]/);
    expect(text).toMatch(/doctor: (OK|FAIL)/);
  });
});
