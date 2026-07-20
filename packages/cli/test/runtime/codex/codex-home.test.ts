/**
 * Tests for `setupCodexHome` — verifies the ephemeral CODEX_HOME
 * structure that gets written for `codex app-server` to read.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupCodexHome } from '../../../src/runtime/agents/codex/codex-home.js';

describe('setupCodexHome', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'csuite-codex-test-'));
  });
  afterEach(() => {
    // setupCodexHome's handle.remove() handles its own cleanup.
    // workDir holds our fake `realCodexHome` and gets cleaned up
    // automatically when the OS reaps tmpdir.
  });

  it('writes a config.toml with the [mcp_servers.csuite] block', () => {
    const fakeRealHome = join(workDir, 'fake-codex');
    mkdirSync(fakeRealHome);
    writeFileSync(join(fakeRealHome, 'auth.json'), '{"token":"fake"}');

    const handle = setupCodexHome({
      realCodexHome: fakeRealHome,
      parentDir: workDir,
      bridgeCommand: '/usr/bin/node',
      bridgeArgs: ['/path/to/cli/dist/index.js', 'mcp-bridge'],
      runnerSocketPath: '/tmp/csuite-runner-xyz.sock',
    });

    try {
      expect(existsSync(handle.path)).toBe(true);
      expect(existsSync(handle.configPath)).toBe(true);

      const toml = readFileSync(handle.configPath, 'utf8');
      expect(toml).toContain('[mcp_servers.csuite]');
      expect(toml).toContain('command = "/usr/bin/node"');
      expect(toml).toContain('args = ["/path/to/cli/dist/index.js", "mcp-bridge"]');
      expect(toml).toContain('enabled = true');
      expect(toml).toContain('default_tools_approval_mode = "approve"');
      expect(toml).toContain('[mcp_servers.csuite.env]');
      expect(toml).toContain('CSUITE_RUNNER_SOCKET = "/tmp/csuite-runner-xyz.sock"');
    } finally {
      handle.remove();
    }
  });

  it('writes an [otel] block when an otel target is supplied', () => {
    const fakeRealHome = join(workDir, 'fake-codex');
    mkdirSync(fakeRealHome);
    writeFileSync(join(fakeRealHome, 'auth.json'), '{}');

    const handle = setupCodexHome({
      realCodexHome: fakeRealHome,
      parentDir: workDir,
      bridgeCommand: 'node',
      bridgeArgs: ['cli', 'mcp-bridge'],
      runnerSocketPath: '/tmp/sock',
      otel: { endpoint: 'https://broker.example/otlp/v1/logs', token: 'csuite_tok_abc' },
    });

    try {
      const toml = readFileSync(handle.configPath, 'utf8');
      expect(toml).toContain('[otel]');
      // Prompts come from the rollout, not the telemetry stream.
      expect(toml).toContain('log_user_prompt = false');
      expect(toml).toContain('endpoint = "https://broker.example/otlp/v1/logs"');
      expect(toml).toContain('protocol = "json"');
      expect(toml).toContain('Authorization = "Bearer csuite_tok_abc"');
    } finally {
      handle.remove();
    }
  });

  it('omits the [otel] block when no otel target is supplied', () => {
    const fakeRealHome = join(workDir, 'fake-codex');
    mkdirSync(fakeRealHome);
    writeFileSync(join(fakeRealHome, 'auth.json'), '{}');

    const handle = setupCodexHome({
      realCodexHome: fakeRealHome,
      parentDir: workDir,
      bridgeCommand: 'node',
      bridgeArgs: ['cli', 'mcp-bridge'],
      runnerSocketPath: '/tmp/sock',
    });

    try {
      expect(readFileSync(handle.configPath, 'utf8')).not.toContain('[otel]');
    } finally {
      handle.remove();
    }
  });

  it('symlinks auth.json from the real codex home', () => {
    const fakeRealHome = join(workDir, 'fake-codex');
    mkdirSync(fakeRealHome);
    const realAuth = join(fakeRealHome, 'auth.json');
    writeFileSync(realAuth, '{"token":"real"}');

    const handle = setupCodexHome({
      realCodexHome: fakeRealHome,
      parentDir: workDir,
      bridgeCommand: 'node',
      bridgeArgs: ['cli', 'mcp-bridge'],
      runnerSocketPath: '/tmp/sock',
    });

    try {
      expect(handle.authLinked).toBe(true);
      const linkedAuth = join(handle.path, 'auth.json');
      const stat = lstatSync(linkedAuth);
      expect(stat.isSymbolicLink()).toBe(true);
      // Reading through the symlink returns the real file contents.
      expect(readFileSync(linkedAuth, 'utf8')).toBe('{"token":"real"}');
    } finally {
      handle.remove();
    }
  });

  it('reports authLinked=false when no real auth.json exists', () => {
    const fakeRealHome = join(workDir, 'no-codex-here');
    // Don't create the dir.

    const handle = setupCodexHome({
      realCodexHome: fakeRealHome,
      parentDir: workDir,
      bridgeCommand: 'node',
      bridgeArgs: ['cli', 'mcp-bridge'],
      runnerSocketPath: '/tmp/sock',
    });

    try {
      expect(handle.authLinked).toBe(false);
      expect(existsSync(join(handle.path, 'auth.json'))).toBe(false);
    } finally {
      handle.remove();
    }
  });

  it('remove() deletes the ephemeral dir and is idempotent', () => {
    const fakeRealHome = join(workDir, 'fake-codex');
    mkdirSync(fakeRealHome);
    writeFileSync(join(fakeRealHome, 'auth.json'), '{}');

    const handle = setupCodexHome({
      realCodexHome: fakeRealHome,
      parentDir: workDir,
      bridgeCommand: 'node',
      bridgeArgs: ['cli', 'mcp-bridge'],
      runnerSocketPath: '/tmp/sock',
    });
    expect(existsSync(handle.path)).toBe(true);

    handle.remove();
    expect(existsSync(handle.path)).toBe(false);

    // Deleting the symlink must not delete the real auth.json.
    expect(existsSync(join(fakeRealHome, 'auth.json'))).toBe(true);

    // Idempotent.
    handle.remove();
    expect(existsSync(handle.path)).toBe(false);
  });

  it('escapes special characters in TOML strings', () => {
    const fakeRealHome = join(workDir, 'fake-codex');
    mkdirSync(fakeRealHome);
    writeFileSync(join(fakeRealHome, 'auth.json'), '{}');

    const handle = setupCodexHome({
      realCodexHome: fakeRealHome,
      parentDir: workDir,
      // Embed a quote and backslash in the bridge command — should be
      // escaped, not break the file.
      bridgeCommand: '/some "weird" path/with\\backslash',
      bridgeArgs: ['mcp-bridge'],
      runnerSocketPath: '/tmp/sock',
    });

    try {
      const toml = readFileSync(handle.configPath, 'utf8');
      expect(toml).toContain('command = "/some \\"weird\\" path/with\\\\backslash"');
    } finally {
      handle.remove();
    }
  });

  it('symlinks sessions/ to the durable dir and remove() keeps the rollouts', () => {
    const fakeRealHome = join(workDir, 'fake-codex');
    mkdirSync(fakeRealHome);
    writeFileSync(join(fakeRealHome, 'auth.json'), '{}');
    const durable = join(workDir, 'durable-sessions');

    const handle = setupCodexHome({
      realCodexHome: fakeRealHome,
      parentDir: workDir,
      bridgeCommand: 'node',
      bridgeArgs: ['cli', 'mcp-bridge'],
      runnerSocketPath: '/tmp/sock',
      sessionsDir: durable,
    });

    expect(handle.sessionsLinked).toBe(true);
    const link = join(handle.path, 'sessions');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    // A rollout codex writes through the link lands in the durable dir…
    writeFileSync(join(link, 'rollout-x.jsonl'), '{}\n');
    expect(existsSync(join(durable, 'rollout-x.jsonl'))).toBe(true);
    // …and survives removal of the ephemeral home.
    handle.remove();
    expect(existsSync(handle.path)).toBe(false);
    expect(existsSync(join(durable, 'rollout-x.jsonl'))).toBe(true);
  });

  it('reports sessionsLinked=false when no sessionsDir is requested', () => {
    const fakeRealHome = join(workDir, 'fake-codex');
    mkdirSync(fakeRealHome);
    writeFileSync(join(fakeRealHome, 'auth.json'), '{}');

    const handle = setupCodexHome({
      realCodexHome: fakeRealHome,
      parentDir: workDir,
      bridgeCommand: 'node',
      bridgeArgs: ['cli', 'mcp-bridge'],
      runnerSocketPath: '/tmp/sock',
    });

    try {
      expect(handle.sessionsLinked).toBe(false);
      expect(existsSync(join(handle.path, 'sessions'))).toBe(false);
    } finally {
      handle.remove();
    }
  });
});
