/**
 * `csuite codex` — wrap an OpenAI Codex CLI session in a csuite runner.
 *
 * Unlike `csuite claude-code` (interactive, with a TUI you talk to in
 * the same terminal), this verb spawns `codex app-server` headlessly.
 * The director communicates with the agent through the broker — chat,
 * DMs, objectives, `csuite push` — and the agent's outputs flow back out
 * through the same channels (or as work products on the local
 * filesystem).
 *
 * Flow:
 *
 *   1. Validate args + locate the codex binary
 *   2. `startRunner()` — fetches briefing, binds the IPC socket, starts
 *      the SSE forwarder. The notification sink is overridden with our
 *      codex channel sink (turn/start vs turn/steer dispatching).
 *   3. `spawnCodex()` — sets up ephemeral CODEX_HOME, writes our
 *      config.toml with the [mcp_servers.csuite] block, spawns codex
 *      app-server, runs the JSON-RPC `initialize` + `thread/start`
 *      handshakes.
 *   4. Wait for either: codex exit, SIGINT, SIGTERM, runner shutdown.
 *   5. Tear down: shutdown adapter (flushes channel sink, kills codex,
 *      removes ephemeral CODEX_HOME), shutdown runner (closes IPC
 *      socket, drains trace uploader, restores presence).
 *
 * Stdout is reserved for human-readable status; structured diagnostics
 * land in the session log at `~/.cache/commandsuite/session-codex-<pid>.log`.
 *
 * Differences vs claude-code:
 *   - No pty. No TUI. The user sees a one-line "agent X connected,
 *     thread Y started" then can Ctrl-C to exit.
 *   - No `.mcp.json` rewrite — codex reads MCP config from the
 *     ephemeral CODEX_HOME, so the user's `~/.codex/config.toml` is
 *     never touched.
 *   - No `--dangerously-load-development-channels` flag — codex's
 *     equivalent is `turn/steer` over JSON-RPC, dispatched by the
 *     channel sink, not a CLI flag.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_PORT, ENV } from 'csuite-sdk/protocol';
import { CodexAdapterError, findCodexBinary, spawnCodex } from '../runtime/agents/codex/adapter.js';
import { type HudHandle, startHud } from '../runtime/hud.js';
import { createPresence } from '../runtime/presence.js';
import { type RunnerHandle, RunnerStartupError, startRunner } from '../runtime/runner.js';
import { createSessionLog } from '../runtime/session-log.js';
import { UsageError } from './errors.js';

export { UsageError };

export interface CodexCommandInput {
  url?: string;
  token?: string;
  /** Working directory for codex. Defaults to process.cwd(). */
  cwd?: string;
  /** Optional model override forwarded as `thread/start`'s `model`. */
  model?: string;
  /**
   * Resume a previous codex thread instead of starting fresh. A string
   * is a thread id (printed in the banner of the run that created it);
   * `true` resumes this member's most recent thread on this machine.
   * `csuite codex --resume [<threadId>]` sets this.
   */
  resume?: string | true;
  /** Disable trace capture. */
  noTrace?: boolean;
  /** Skip resolving/injecting broker-held secrets. */
  noSecrets?: boolean;
  /**
   * Extra args forwarded verbatim to `codex app-server`. Populated by
   * everything the caller passes after `--` on the command line.
   */
  codexArgs?: string[];
  /** Optional logger override; defaults to a session log + stderr. */
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
  /** Override the bridge command (tests). */
  bridgeCommand?: string;
  /** Override the bridge args (tests). */
  bridgeArgs?: string[];
}

export async function runCodexCommand(input: CodexCommandInput): Promise<number> {
  const ownedSessionLog = input.log ? null : createSessionLog({ component: 'codex' });
  const log = input.log ?? (ownedSessionLog as NonNullable<typeof ownedSessionLog>).log;
  const url = input.url ?? process.env[ENV.url] ?? `http://127.0.0.1:${DEFAULT_PORT}`;
  const token = input.token ?? process.env[ENV.token];
  if (!token) {
    throw new UsageError(
      `--token or ${ENV.token} is required — run \`csuite connect\` to enroll this device, or pass the user's bearer token explicitly`,
    );
  }
  const cwd = input.cwd ?? process.cwd();

  // 1. Locate codex first; fail fast before touching anything.
  let codexBinary: string;
  try {
    codexBinary = findCodexBinary();
  } catch (err) {
    if (err instanceof CodexAdapterError) {
      throw new UsageError(err.message);
    }
    throw err;
  }

  // 2. Auto-detect the bridge command. Same logic as claude-code:
  //    use the same node binary that's running the cli, pointing
  //    at the cli's own dist/index.js.
  const bridgeCommand = input.bridgeCommand ?? process.execPath;
  const bridgeArgs =
    input.bridgeArgs ?? (process.argv[1] ? [process.argv[1], 'mcp-bridge'] : ['mcp-bridge']);

  // 3. Start the runner. The runner needs a notification sink up
  //    front, but the codex sink can't exist until after spawnCodex
  //    creates the JSON-RPC client. Resolution: install a buffering
  //    wrapper that queues notifications until the real sink is
  //    plugged in via `attach()`, then drains the queue.
  //
  //    Why a queue (not a drop): the broker's SSE subscription replays
  //    any unread messages immediately on connect. Codex cold-start
  //    (plugin sync, model refresh) takes 5-15s, and during that
  //    window the forwarder is already receiving events. Dropping
  //    them silently meant the agent missed the very first messages
  //    in its inbox — including any DM addressed at it that arrived
  //    while it was offline. The queue closes that gap.
  type Sink = import('../runtime/forwarder.js').ForwarderNotificationSink;
  type SinkArgs = Parameters<Sink['notification']>[0];
  let liveSink: Sink | null = null;
  const pendingArgs: SinkArgs[] = [];
  const sinkWrapper: Sink = {
    async notification(args) {
      if (liveSink === null) {
        pendingArgs.push(args);
        return;
      }
      await liveSink.notification(args);
    },
  };
  const attachSink = async (sink: Sink): Promise<void> => {
    liveSink = sink;
    if (pendingArgs.length === 0) return;
    log('codex: draining pre-attach broker queue', { queued: pendingArgs.length });
    const drain = pendingArgs.splice(0, pendingArgs.length);
    for (const args of drain) {
      try {
        await sink.notification(args);
      } catch (err) {
        log('codex: drain notification failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };

  const presence = createPresence();
  let runner: RunnerHandle;
  try {
    runner = await startRunner({
      url,
      token,
      log,
      presence,
      noTrace: input.noTrace,
      noSecrets: input.noSecrets,
      notificationSink: sinkWrapper,
      // Codex spawns a fresh `csuite mcp-bridge` per thread — including
      // every subagent it dispatches. Those extra bridges would displace
      // the root thread's bridge under the default `displace-old`,
      // breaking the root agent's csuite tools (the "Transport closed"
      // failure). `reject-new` keeps the root's bridge pinned and refuses
      // subagent bridges instead: subagents stay off the net (no inbound
      // notifications, no gaggle) and simply have no csuite tools, while
      // the root agent keeps sending and receiving normally.
      onSecondBridge: 'reject-new',
    });
  } catch (err) {
    if (err instanceof RunnerStartupError) {
      ownedSessionLog?.close();
      throw new UsageError(err.message);
    }
    ownedSessionLog?.close();
    throw err;
  }
  log('codex: runner started', {
    socketPath: runner.socketPath,
    name: runner.briefing.name,
    role: runner.briefing.role.title,
    team: runner.briefing.team.name,
  });

  // 4. Heads-up to the user: codex headless mode + cwd disclosure.
  //    Mirrors claude-code's "runner cwd / .mcp.json" line.
  process.stderr.write(
    `csuite codex: runner cwd = ${resolve(cwd)}\n` +
      `csuite codex: agent = ${runner.briefing.name} (${runner.briefing.role.title}) on team ${runner.briefing.team.name}\n` +
      (ownedSessionLog?.path ? `csuite codex: session log = ${ownedSessionLog.path}\n` : ''),
  );

  // 5. Spawn codex.
  let spawned: Awaited<ReturnType<typeof spawnCodex>>;
  try {
    spawned = await spawnCodex({
      briefing: runner.briefing,
      runnerSocketPath: runner.socketPath,
      bridgeCommand,
      bridgeArgs,
      captureHost: runner.captureHost,
      secretsEnv: runner.secretsEnv,
      codexBinary,
      cwd,
      model: input.model,
      resume: input.resume,
      codexArgs: input.codexArgs,
      presence,
      // Share the capture host's busy signal so codex tool-lifecycle
      // notifications feed the same observable claude's hooks drive.
      // Null when --no-trace.
      busy: runner.captureHost?.busy,
      log,
    });
  } catch (err) {
    await runner.shutdown('codex-spawn-failed').catch(() => {});
    ownedSessionLog?.close();
    if (err instanceof CodexAdapterError) {
      throw new UsageError(err.message);
    }
    throw err;
  }
  await attachSink(spawned.channelSink);

  // Surface the thread id so the operator can pick this session back up
  // later — the codex analogue of claude-code's session id.
  const threadId = spawned.getThreadId();
  process.stderr.write(
    (threadId
      ? `csuite codex: thread ${threadId}${input.resume ? ' (resumed)' : ''} — pick it up later with: csuite codex --resume ${threadId}\n`
      : '') +
      `csuite codex: agent connected — Ctrl-C to stop. Direct it via the broker:\n` +
      `    csuite push --agent ${runner.briefing.name} --body "your instructions"\n\n`,
  );

  // 5a. HUD strip — same chrome as `csuite claude-code` (2-row footer
  //     pinned to the bottom showing `csuite · ● <state>` + agent name).
  //     For codex the value is even higher than for claude-code: the
  //     agent emits no terminal output of its own, so without the
  //     strip a long-idle session looks identical to a hung one.
  //
  //     `reserveBottomSpace: true` is essential here. Our prior
  //     stderr banners scrolled the terminal so the cursor sits at the
  //     bottom row; if we let `startHud` set the scroll region without
  //     reserving first, the cursor lands *outside* the region and the
  //     activity printer's writes paint over the HUD strip instead of
  //     scrolling above it. claude-code doesn't need this because
  //     claude enters the alternate screen buffer first.
  //
  //     `redraw()` once explicitly: the HUD defers its first render
  //     until the caller asks (so it doesn't interleave with a tty
  //     handshake), and for codex there's no PTY relay to drive it.
  //     A no-op when stdout isn't a TTY.
  const hud: HudHandle = startHud({
    presence,
    label: `csuite codex · ${runner.briefing.name}`,
    reserveBottomSpace: true,
    log,
  });
  hud.redraw();

  // 6. Teardown. Drain on any of: codex exit, SIGINT, SIGTERM,
  //    uncaught exception. Idempotent.
  let teardownDone = false;
  const teardown = async (reason: string): Promise<number> => {
    if (teardownDone) return 0;
    teardownDone = true;
    log('codex: tearing down', { reason });
    // Close the HUD first so its DECSTBM scroll-region is released
    // before shutdown chatter scrolls. Otherwise the final teardown
    // lines would scroll *within* the region and leave the strip
    // visually stranded on top of new prompt text.
    hud.close();
    let exit = 0;
    try {
      await spawned.shutdown(reason);
      exit = await spawned.exitCode;
    } catch (err) {
      log('codex: adapter shutdown failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      exit = 1;
    }
    await runner.shutdown(reason).catch((err) => {
      log('codex: runner shutdown failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    ownedSessionLog?.close();
    return exit;
  };

  let onSigint: () => void = () => {};
  let onSigterm: () => void = () => {};

  // 7. Wait for whichever event ends the session first.
  const exitCode = await new Promise<number>((resolvePromise) => {
    const finish = (reason: string): void => {
      void teardown(reason).then((code) => resolvePromise(code));
    };
    onSigint = () => finish('SIGINT');
    onSigterm = () => finish('SIGTERM');
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    spawned.exitCode.then((code) => {
      // Codex exited on its own — drain teardown but propagate codex's
      // exit code rather than 0.
      void teardown('codex-exited').then(() => resolvePromise(code));
    });
  });

  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigterm);

  // Verify cwd existed at start — surfaces "user passed --cwd <typo>"
  // as a clean error instead of a confusing codex-side failure.
  // This is a defensive check that runs after teardown so a bad cwd
  // still tears down cleanly.
  if (!existsSync(cwd)) {
    process.stderr.write(`csuite codex: warning — cwd ${cwd} did not exist at exit\n`);
  }

  return exitCode;
}
