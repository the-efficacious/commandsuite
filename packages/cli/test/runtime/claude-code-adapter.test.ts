/**
 * Claude Code adapter unit tests.
 *
 * Covers the `.mcp.json` backup/restore contract for prepareMcpConfig:
 *
 *   - Fresh creation when the file was absent
 *   - Merge into an existing file, preserving other top-level keys and
 *     other mcpServers entries
 *   - Restore paths for all three "existed before" states:
 *       (a) file didn't exist      → restore deletes it
 *       (b) file existed, no csuite    → restore rewrites original bytes
 *       (c) file had a stale csuite    → restore rewrites original bytes
 *   - Refusal to modify when the existing file is corrupt JSON
 *   - Restore is idempotent — calling it twice is a no-op on the second
 *
 * Every test uses a fresh tmpdir so they don't stomp each other and
 * tests never touch the repo's real `.mcp.json`.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ClaudeCodeAdapterError,
  prepareClaudeSettings,
  prepareMcpConfig,
  writeMcpConfigFile,
} from '../../src/runtime/agents/claude-code.js';

describe('prepareMcpConfig', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'csuite-adapter-test-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('creates a fresh .mcp.json when none existed, then restore deletes it', () => {
    const configPath = join(cwd, '.mcp.json');
    expect(existsSync(configPath)).toBe(false);

    const handle = prepareMcpConfig({
      cwd,
      runnerSocketPath: '/tmp/fake-runner.sock',
    });

    expect(handle.path).toBe(configPath);
    expect(existsSync(configPath)).toBe(true);
    const written = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(written.mcpServers.csuite).toEqual({
      command: 'csuite',
      args: ['mcp-bridge'],
      env: { CSUITE_RUNNER_SOCKET: '/tmp/fake-runner.sock' },
    });

    handle.restore();
    expect(existsSync(configPath)).toBe(false);
  });

  it('merges into an existing file and preserves other entries + top-level keys', () => {
    const configPath = join(cwd, '.mcp.json');
    const original = {
      hooks: { preToolUse: 'echo hi' },
      mcpServers: {
        other: {
          command: 'node',
          args: ['some-other-mcp.js'],
        },
      },
    };
    writeFileSync(configPath, JSON.stringify(original, null, 2), 'utf8');

    const handle = prepareMcpConfig({
      cwd,
      runnerSocketPath: '/tmp/fake.sock',
      bridgeCommand: '/abs/path/to/cli.js',
      bridgeArgs: ['mcp-bridge', '--trace'],
      extraEnv: { ALL_PROXY: 'socks5://127.0.0.1:9050' },
    });

    const merged = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(merged.hooks).toEqual({ preToolUse: 'echo hi' });
    expect(merged.mcpServers.other).toEqual({
      command: 'node',
      args: ['some-other-mcp.js'],
    });
    expect(merged.mcpServers.csuite).toEqual({
      command: '/abs/path/to/cli.js',
      args: ['mcp-bridge', '--trace'],
      env: {
        CSUITE_RUNNER_SOCKET: '/tmp/fake.sock',
        ALL_PROXY: 'socks5://127.0.0.1:9050',
      },
    });

    handle.restore();
    const afterRestore = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(afterRestore).toEqual(original);
  });

  it('replaces a stale csuite entry and restores the original on teardown', () => {
    const configPath = join(cwd, '.mcp.json');
    const original = {
      mcpServers: {
        csuite: {
          command: 'csuite',
          args: ['mcp-bridge'],
          env: { CSUITE_RUNNER_SOCKET: '/tmp/OLD.sock' },
        },
      },
    };
    writeFileSync(configPath, JSON.stringify(original, null, 2), 'utf8');

    const handle = prepareMcpConfig({
      cwd,
      runnerSocketPath: '/tmp/NEW.sock',
    });

    const merged = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(merged.mcpServers.csuite.env.CSUITE_RUNNER_SOCKET).toBe('/tmp/NEW.sock');

    handle.restore();
    const afterRestore = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(afterRestore).toEqual(original);
  });

  it('refuses to modify a corrupt .mcp.json and leaves the file untouched', () => {
    const configPath = join(cwd, '.mcp.json');
    const corrupt = '{ "mcpServers": { not valid json';
    writeFileSync(configPath, corrupt, 'utf8');

    expect(() =>
      prepareMcpConfig({
        cwd,
        runnerSocketPath: '/tmp/x.sock',
      }),
    ).toThrow(ClaudeCodeAdapterError);

    expect(readFileSync(configPath, 'utf8')).toBe(corrupt);
  });

  it('refuses to modify when top-level is not an object (e.g. array)', () => {
    const configPath = join(cwd, '.mcp.json');
    const arrayJson = '[1, 2, 3]';
    writeFileSync(configPath, arrayJson, 'utf8');

    expect(() =>
      prepareMcpConfig({
        cwd,
        runnerSocketPath: '/tmp/x.sock',
      }),
    ).toThrow(ClaudeCodeAdapterError);

    expect(readFileSync(configPath, 'utf8')).toBe(arrayJson);
  });

  it('restore is idempotent — second call is a no-op', () => {
    const configPath = join(cwd, '.mcp.json');
    const handle = prepareMcpConfig({
      cwd,
      runnerSocketPath: '/tmp/x.sock',
    });
    expect(existsSync(configPath)).toBe(true);

    handle.restore();
    expect(existsSync(configPath)).toBe(false);

    // Recreate a different file at the same path — restore should NOT
    // touch it, since we've already restored once.
    writeFileSync(configPath, '{"unrelated":true}', 'utf8');
    handle.restore();
    expect(readFileSync(configPath, 'utf8')).toBe('{"unrelated":true}');
  });

  it('injects default bridge command + args when options omit them', () => {
    const handle = prepareMcpConfig({
      cwd,
      runnerSocketPath: '/tmp/defaults.sock',
    });
    const merged = JSON.parse(readFileSync(join(cwd, '.mcp.json'), 'utf8'));
    expect(merged.mcpServers.csuite.command).toBe('csuite');
    expect(merged.mcpServers.csuite.args).toEqual(['mcp-bridge']);
    handle.restore();
  });
});

describe('writeMcpConfigFile', () => {
  let parentDir: string;

  beforeEach(() => {
    parentDir = mkdtempSync(join(tmpdir(), 'csuite-mcp-parent-'));
  });

  afterEach(() => {
    rmSync(parentDir, { recursive: true, force: true });
  });

  it('writes a csuite server entry to an ephemeral file under parentDir', () => {
    const handle = writeMcpConfigFile({
      runnerSocketPath: '/tmp/fake-runner.sock',
      bridgeCommand: '/usr/bin/node',
      bridgeArgs: ['/abs/cli.js', 'mcp-bridge'],
      parentDir,
    });

    // The file lives under our ephemeral parent, not any project cwd.
    expect(handle.path.startsWith(parentDir)).toBe(true);
    expect(existsSync(handle.path)).toBe(true);

    const written = JSON.parse(readFileSync(handle.path, 'utf8'));
    expect(written.mcpServers.csuite).toEqual({
      command: '/usr/bin/node',
      args: ['/abs/cli.js', 'mcp-bridge'],
      env: { CSUITE_RUNNER_SOCKET: '/tmp/fake-runner.sock' },
    });

    handle.cleanup();
  });

  it('returns --mcp-config flag args pointing at the written file', () => {
    const handle = writeMcpConfigFile({
      runnerSocketPath: '/tmp/x.sock',
      parentDir,
    });
    expect(handle.flagArgs).toEqual(['--mcp-config', handle.path]);
    handle.cleanup();
  });

  it('defaults the bridge command + args when omitted', () => {
    const handle = writeMcpConfigFile({ runnerSocketPath: '/tmp/x.sock', parentDir });
    const written = JSON.parse(readFileSync(handle.path, 'utf8'));
    expect(written.mcpServers.csuite.command).toBe('csuite');
    expect(written.mcpServers.csuite.args).toEqual(['mcp-bridge']);
    handle.cleanup();
  });

  it('merges extraEnv into the server env block', () => {
    const handle = writeMcpConfigFile({
      runnerSocketPath: '/tmp/x.sock',
      extraEnv: { ALL_PROXY: 'socks5://127.0.0.1:9050' },
      parentDir,
    });
    const written = JSON.parse(readFileSync(handle.path, 'utf8'));
    expect(written.mcpServers.csuite.env).toEqual({
      CSUITE_RUNNER_SOCKET: '/tmp/x.sock',
      ALL_PROXY: 'socks5://127.0.0.1:9050',
    });
    handle.cleanup();
  });

  it('writes the file 0o600 (the env block carries the socket path)', () => {
    const handle = writeMcpConfigFile({ runnerSocketPath: '/tmp/x.sock', parentDir });
    // Low 9 permission bits should be owner-only rw.
    expect(statSync(handle.path).mode & 0o777).toBe(0o600);
    handle.cleanup();
  });

  it('gives concurrent runs isolated files that never collide', () => {
    const a = writeMcpConfigFile({ runnerSocketPath: '/tmp/a.sock', parentDir });
    const b = writeMcpConfigFile({ runnerSocketPath: '/tmp/b.sock', parentDir });

    // Different ephemeral dirs → different paths → no shared-file race.
    expect(a.path).not.toBe(b.path);
    expect(dirname(a.path)).not.toBe(dirname(b.path));

    // Each carries its own socket; neither clobbered the other.
    expect(
      JSON.parse(readFileSync(a.path, 'utf8')).mcpServers.csuite.env.CSUITE_RUNNER_SOCKET,
    ).toBe('/tmp/a.sock');
    expect(
      JSON.parse(readFileSync(b.path, 'utf8')).mcpServers.csuite.env.CSUITE_RUNNER_SOCKET,
    ).toBe('/tmp/b.sock');

    // Cleaning one leaves the other intact.
    a.cleanup();
    expect(existsSync(a.path)).toBe(false);
    expect(existsSync(b.path)).toBe(true);
    b.cleanup();
  });

  it('cleanup removes the ephemeral dir and is idempotent', () => {
    const handle = writeMcpConfigFile({ runnerSocketPath: '/tmp/x.sock', parentDir });
    const dir = dirname(handle.path);
    expect(existsSync(dir)).toBe(true);

    handle.cleanup();
    expect(existsSync(dir)).toBe(false);

    // Second call is a no-op — must not throw even though the dir is gone.
    expect(() => handle.cleanup()).not.toThrow();
  });
});

describe('prepareClaudeSettings', () => {
  let cwd: string;
  const hookUrl = 'http://127.0.0.1:55555/hook/tool-event';

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'csuite-claude-settings-test-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('creates .claude/settings.json when neither dir nor file existed, restore removes both', () => {
    const dirPath = join(cwd, '.claude');
    const settingsPath = join(dirPath, 'settings.json');
    expect(existsSync(dirPath)).toBe(false);

    const handle = prepareClaudeSettings({ cwd, hookUrl });

    expect(handle.path).toBe(settingsPath);
    expect(existsSync(settingsPath)).toBe(true);
    const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
    for (const event of [
      'PreToolUse',
      'PostToolUse',
      'PostToolUseFailure',
      'UserPromptSubmit',
      'Stop',
      'SubagentStop',
      'Notification',
      'SessionStart',
    ]) {
      const matchers = written.hooks[event];
      expect(Array.isArray(matchers)).toBe(true);
      const csuite = matchers
        .flatMap((m: { hooks: unknown[] }) => m.hooks)
        .find(
          (h: Record<string, unknown>) =>
            h.type === 'http' && h.url === hookUrl && h.x_csuite_busy_feeder === true,
        );
      expect(csuite).toBeTruthy();
    }

    handle.restore();
    expect(existsSync(settingsPath)).toBe(false);
    expect(existsSync(dirPath)).toBe(false);
  });

  it('merges into existing settings.json while preserving other keys + other hooks', () => {
    const dirPath = join(cwd, '.claude');
    const settingsPath = join(dirPath, 'settings.json');
    // Pre-existing user config: a hook for an event csuite does NOT
    // manage (PreCompact), a user hook on an event we DO manage
    // (SessionStart), AND an unrelated top-level key. All must survive
    // the merge.
    require('node:fs').mkdirSync(dirPath, { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({
        permissions: { allow: ['Bash'] },
        hooks: {
          PreCompact: [{ matcher: '*', hooks: [{ type: 'command', command: 'notify-send pre' }] }],
          SessionStart: [
            { matcher: '*', hooks: [{ type: 'command', command: 'notify-send done' }] },
          ],
        },
      }),
    );

    const handle = prepareClaudeSettings({ cwd, hookUrl });
    const merged = JSON.parse(readFileSync(settingsPath, 'utf8'));

    // Unrelated top-level key preserved.
    expect(merged.permissions).toEqual({ allow: ['Bash'] });
    // User's PreCompact hook (an event we don't manage) preserved verbatim.
    expect(merged.hooks.PreCompact).toEqual([
      { matcher: '*', hooks: [{ type: 'command', command: 'notify-send pre' }] },
    ]);
    // SessionStart is a managed event now: the user's entry survives
    // and our http entry is appended alongside it.
    const sessionStartEntries = merged.hooks.SessionStart.flatMap(
      (m: { hooks: unknown[] }) => m.hooks,
    );
    expect(sessionStartEntries).toContainEqual({
      type: 'command',
      command: 'notify-send done',
    });
    expect(sessionStartEntries).toContainEqual({
      type: 'http',
      url: hookUrl,
      x_csuite_busy_feeder: true,
    });
    // Our PreToolUse hook injected.
    expect(merged.hooks.PreToolUse).toBeTruthy();
    const preToolEntries = merged.hooks.PreToolUse.flatMap((m: { hooks: unknown[] }) => m.hooks);
    expect(preToolEntries).toContainEqual({
      type: 'http',
      url: hookUrl,
      x_csuite_busy_feeder: true,
    });
    // Our Stop hook (now a managed event) injected too.
    const stopEntries = merged.hooks.Stop.flatMap((m: { hooks: unknown[] }) => m.hooks);
    expect(stopEntries).toContainEqual({
      type: 'http',
      url: hookUrl,
      x_csuite_busy_feeder: true,
    });

    handle.restore();
    // Restore writes the original bytes back — the user's hooks are
    // still there, our injected entries gone.
    const restored = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(restored.hooks.PreToolUse).toBeUndefined();
    expect(restored.hooks.Stop).toBeUndefined();
    expect(restored.hooks.PreCompact).toEqual([
      { matcher: '*', hooks: [{ type: 'command', command: 'notify-send pre' }] },
    ]);
    expect(restored.hooks.SessionStart).toEqual([
      { matcher: '*', hooks: [{ type: 'command', command: 'notify-send done' }] },
    ]);
    expect(restored.permissions).toEqual({ allow: ['Bash'] });
  });

  it('drops a stale csuite hook entry from a previous crash before injecting fresh ones', () => {
    const dirPath = join(cwd, '.claude');
    const settingsPath = join(dirPath, 'settings.json');
    require('node:fs').mkdirSync(dirPath, { recursive: true });
    // Simulate a previous run that crashed mid-restore, leaving a
    // stale csuite entry behind. Our prepare should NOT duplicate it.
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: '*',
              hooks: [
                { type: 'http', url: 'http://stale.local/hook', x_csuite_busy_feeder: true },
                { type: 'command', command: 'audit-log' },
              ],
            },
          ],
        },
      }),
    );

    const handle = prepareClaudeSettings({ cwd, hookUrl });
    const merged = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const entries = merged.hooks.PreToolUse.flatMap(
      (m: { hooks: Record<string, unknown>[] }) => m.hooks,
    );
    // Stale csuite entry gone.
    expect(
      entries.filter((e: Record<string, unknown>) => e.url === 'http://stale.local/hook'),
    ).toHaveLength(0);
    // User's unrelated audit-log hook preserved.
    expect(entries.find((e: Record<string, unknown>) => e.command === 'audit-log')).toBeTruthy();
    // Fresh csuite entry pointing at the current hook URL.
    expect(entries.find((e: Record<string, unknown>) => e.url === hookUrl)).toBeTruthy();
    handle.restore();
  });

  it('refuses to modify when existing settings.json is not valid JSON', () => {
    const dirPath = join(cwd, '.claude');
    const settingsPath = join(dirPath, 'settings.json');
    require('node:fs').mkdirSync(dirPath, { recursive: true });
    writeFileSync(settingsPath, 'not-json');
    expect(() => prepareClaudeSettings({ cwd, hookUrl })).toThrow(ClaudeCodeAdapterError);
    // Original file untouched.
    expect(readFileSync(settingsPath, 'utf8')).toBe('not-json');
  });

  it('restore() is idempotent — second call is a no-op', () => {
    const handle = prepareClaudeSettings({ cwd, hookUrl });
    handle.restore();
    expect(() => handle.restore()).not.toThrow();
  });

  it('preserves the .claude/ dir on restore if other files live there', () => {
    const dirPath = join(cwd, '.claude');
    require('node:fs').mkdirSync(dirPath, { recursive: true });
    // User had something else in .claude/ but no settings.json yet.
    writeFileSync(join(dirPath, 'agents.md'), '# my agents');
    const handle = prepareClaudeSettings({ cwd, hookUrl });
    handle.restore();
    // Settings file gone, but the .claude/ dir + agents.md stay because
    // the dir existed before our prepare touched it.
    expect(existsSync(join(dirPath, 'settings.json'))).toBe(false);
    expect(existsSync(join(dirPath, 'agents.md'))).toBe(true);
  });
});
