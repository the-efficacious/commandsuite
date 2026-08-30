/**
 * The Agent SDK is an optional dependency (obj-mtfp3ulq-e): a default
 * install carries it and `csuite claude` works; a broker-only install
 * omits it (`--no-optional` / `--omit=optional`) and every broker verb
 * still works, with the claude verb failing fast and the doctor
 * reporting the binary as absent by design rather than FAIL.
 *
 * The runtime absent path is proven end-to-end by the container CI,
 * which runs the broker image (installed without optional deps) through
 * compose-check including an in-container doctor. What lives here is
 * everything assertable from a default install: the published manifest
 * shape, the default-install resolution (positive control), the error
 * contract, the doctor's WARN/FAIL split, and that the built dist
 * imports the SDK by bare specifier instead of bundling it.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runAgentDoctor } from '../src/commands/doctor.js';
import type { AgentAdapter } from '../src/runtime/agents/adapter.js';
import { AgentAdapterError } from '../src/runtime/agents/adapter.js';
import { ClaudeSdkAbsentError, resolveClaudeExecutable } from '../src/runtime/agents/claude.js';

const pkgDir = join(import.meta.dirname, '..');

describe('optional agent SDK — manifest shape', () => {
  // `npm pack` publishes these dependency fields verbatim, so the
  // source manifest is the packed manifest for this assertion.
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };

  it('declares the SDK under optionalDependencies only', () => {
    expect(pkg.optionalDependencies?.['@anthropic-ai/claude-agent-sdk']).toBeDefined();
    expect(pkg.dependencies?.['@anthropic-ai/claude-agent-sdk']).toBeUndefined();
    expect(pkg.peerDependencies?.['@anthropic-ai/claude-agent-sdk']).toBeUndefined();
  });
});

describe('optional agent SDK — default install resolves', () => {
  // npm and pnpm install optionalDependencies by default, so this
  // workspace install has the SDK: the claim "a fresh install still
  // yields a working `csuite claude`" reduces to resolution succeeding
  // here. The broker-only counterpart runs in the container CI.
  it('resolveClaudeExecutable() finds the bundled CLI and its SDK version', () => {
    const saved = process.env.CLAUDE_PATH;
    delete process.env.CLAUDE_PATH;
    try {
      const exe = resolveClaudeExecutable();
      expect(exe.source).toBe('bundled');
      expect(exe.path.length).toBeGreaterThan(0);
      expect(exe.sdkVersion).not.toBeNull();
    } finally {
      if (saved !== undefined) process.env.CLAUDE_PATH = saved;
    }
  });
});

describe('optional agent SDK — absent error contract', () => {
  it('is absent-by-design and tells the operator the package and the install command', () => {
    const err = new ClaudeSdkAbsentError();
    expect(err.absentByDesign).toBe(true);
    expect(err.message).toContain('@anthropic-ai/claude-agent-sdk');
    expect(err.message).toContain('npm install @anthropic-ai/claude-agent-sdk');
  });

  it('plain adapter errors stay absentByDesign=false (positive control)', () => {
    expect(new AgentAdapterError('boom').absentByDesign).toBe(false);
  });
});

function stubAdapter(locateError: Error): AgentAdapter {
  return {
    meta: { id: 'claude', versionArgs: null, testedVersions: null },
    locate() {
      throw locateError;
    },
  } as unknown as AgentAdapter;
}

describe('optional agent SDK — doctor mapping', () => {
  it('reports an absent-by-design SDK as WARN, not FAIL', async () => {
    const report = await runAgentDoctor(stubAdapter(new ClaudeSdkAbsentError()), {
      includeVersion: false,
    });
    const binary = report.checks.find((c) => c.name === 'claude binary');
    expect(binary?.status).toBe('WARN');
    expect(binary?.detail).toMatch(/^absent by design — /);
    expect(binary?.detail).toContain('@anthropic-ai/claude-agent-sdk');
  });

  it('reports any other locate() failure as FAIL (positive control)', async () => {
    const report = await runAgentDoctor(
      stubAdapter(new AgentAdapterError('CLAUDE_PATH is broken')),
      {
        includeVersion: false,
      },
    );
    const binary = report.checks.find((c) => c.name === 'claude binary');
    expect(binary?.status).toBe('FAIL');
    expect(report.anyFail).toBe(true);
  });
});

describe('optional agent SDK — dist externality', () => {
  // tsup auto-externalizes `dependencies` but not `optionalDependencies`;
  // the config lists the SDK explicitly. If that regresses, the bare
  // specifier disappears from dist (rewritten to a bundled chunk path)
  // and the SDK's JS ships everywhere, defeating the absent gate.
  it('dist imports the SDK by bare specifier instead of bundling it', () => {
    const distDir = join(pkgDir, 'dist');
    const sources = readdirSync(distDir)
      .filter((f) => f.endsWith('.js'))
      .map((f) => readFileSync(join(distDir, f), 'utf8'));
    const bareImport = sources.some(
      (s) =>
        s.includes('import("@anthropic-ai/claude-agent-sdk")') ||
        s.includes("import('@anthropic-ai/claude-agent-sdk')"),
    );
    expect(bareImport).toBe(true);
  });
});
