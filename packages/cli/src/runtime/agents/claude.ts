/**
 * Low-level helpers for the Claude runner: locating the Claude Code
 * executable the Agent SDK will drive, and the adapter's operator-error
 * type.
 *
 * The runner embeds the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`),
 * which ships its own Claude Code CLI in a per-platform sibling package
 * (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>`). Config that the
 * old CLI wrapper delivered by rewriting operator files — `.mcp.json`
 * entries, `.claude/settings.json` hooks — now travels as SDK options,
 * so nothing here touches the working tree and there is nothing to back
 * up or restore.
 *
 * `CLAUDE_PATH` remains the escape hatch: when set, the SDK is pointed
 * at that executable instead of the bundled one (used by the
 * conformance suite to substitute a fake agent, and available to
 * operators who need a specific Claude Code build).
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { AgentAdapterError } from './adapter.js';

/** Operator-facing claude runner error (clean message, exit 2). */
export class ClaudeCodeAdapterError extends AgentAdapterError {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeCodeAdapterError';
  }
}

/**
 * The Agent SDK — an optional dependency of csuite — is not installed
 * at all. A broker-only install (`--omit=optional`) lands here on
 * purpose; the doctor reads `absentByDesign` and reports it as
 * advisory rather than FAIL. A present-but-broken SDK (missing
 * platform binary, dead `CLAUDE_PATH`) stays a plain
 * `ClaudeCodeAdapterError`.
 */
export class ClaudeSdkAbsentError extends ClaudeCodeAdapterError {
  override readonly absentByDesign = true;

  constructor() {
    super(
      '@anthropic-ai/claude-agent-sdk is not installed (an optional dependency of csuite) — ' +
        'run `npm install @anthropic-ai/claude-agent-sdk` where csuite is installed, ' +
        'or reinstall csuite with optional dependencies included (the default).',
    );
    this.name = 'ClaudeSdkAbsentError';
  }
}

export interface ClaudeExecutable {
  /** Absolute path of the Claude Code executable the SDK will spawn. */
  path: string;
  /**
   * Where the executable came from: the `CLAUDE_PATH` override or the
   * SDK's bundled per-platform CLI package.
   */
  source: 'env' | 'bundled';
  /** `@anthropic-ai/claude-agent-sdk` package version, when resolvable. */
  sdkVersion: string | null;
  /**
   * Claude Code version the SDK bundles (from the SDK's manifest).
   * `null` for `CLAUDE_PATH` overrides — the doctor's version probe
   * reports the override's actual version instead.
   */
  bundledCliVersion: string | null;
}

const require = createRequire(import.meta.url);

/**
 * Resolve the Claude Code executable for this host.
 *
 * Order: `CLAUDE_PATH` (must exist — a broken override is an error, not
 * a fallback), then the Agent SDK's bundled CLI for this platform.
 * Throws `ClaudeCodeAdapterError` with an actionable message when
 * neither resolves. No side effects — safe for `locate()`.
 */
export function resolveClaudeExecutable(): ClaudeExecutable {
  const override = process.env.CLAUDE_PATH;
  if (override !== undefined && override.length > 0) {
    if (!existsSync(override)) {
      throw new ClaudeCodeAdapterError(
        `CLAUDE_PATH points at ${override}, which does not exist. Unset it to use the SDK's bundled Claude Code.`,
      );
    }
    return {
      path: override,
      source: 'env',
      sdkVersion: readSdkVersion(findSdkDir()),
      bundledCliVersion: null,
    };
  }

  const sdkDir = findSdkDir();
  if (sdkDir === null) {
    throw new ClaudeSdkAbsentError();
  }

  // The CLI lives in a per-platform sibling package that is a
  // dependency of the SDK, not of csuite — under pnpm's isolated
  // layout it resolves from the SDK's own directory, not from ours.
  const platformKey = `${process.platform}-${process.arch}`;
  const platformPkg = `@anthropic-ai/claude-agent-sdk-${platformKey}`;
  let binPath: string | null = null;
  try {
    binPath = createRequire(join(sdkDir, 'noop.js')).resolve(`${platformPkg}/claude`);
  } catch {
    // Exports-map or layout mismatch — fall back to the scope-sibling
    // path (`@anthropic-ai/claude-agent-sdk-<key>` next to the SDK).
    const sibling = join(sdkDir, '..', `claude-agent-sdk-${platformKey}`, 'claude');
    if (existsSync(sibling)) binPath = sibling;
  }
  if (binPath === null) {
    throw new ClaudeCodeAdapterError(
      `the Agent SDK's Claude Code binary for ${platformKey} is not installed ` +
        `(${platformPkg}). Reinstall csuite on this platform, ` +
        'or set CLAUDE_PATH to a Claude Code executable.',
    );
  }

  return {
    path: binPath,
    source: 'bundled',
    sdkVersion: readSdkVersion(sdkDir),
    bundledCliVersion: readBundledCliVersion(sdkDir),
  };
}

/**
 * Directory of the installed SDK package, or `null` when absent. The
 * SDK's exports map hides package.json, so resolve the entry module
 * and take its directory.
 */
function findSdkDir(): string | null {
  try {
    return dirname(require.resolve('@anthropic-ai/claude-agent-sdk'));
  } catch {
    return null;
  }
}

function readSdkVersion(sdkDir: string | null): string | null {
  if (sdkDir === null) return null;
  try {
    const pkg = JSON.parse(readFileSync(join(sdkDir, 'package.json'), 'utf8')) as {
      version?: string;
    };
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

/** The SDK's manifest.json records the exact Claude Code build it ships. */
function readBundledCliVersion(sdkDir: string): string | null {
  try {
    const manifest = JSON.parse(readFileSync(join(sdkDir, 'manifest.json'), 'utf8')) as {
      version?: string;
    };
    return typeof manifest.version === 'string' ? manifest.version : null;
  } catch {
    return null;
  }
}
