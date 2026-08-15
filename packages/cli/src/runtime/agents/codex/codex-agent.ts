/**
 * OpenAI Codex AgentAdapter — the `csuite codex` runner expressed
 * through the shared adapter contract (`../adapter.ts`).
 *
 * Framework-specific knowledge lives here and ONLY here:
 *
 *   - locating the `codex` binary
 *   - the buffering channel sink (broker events queue until the
 *     app-server handshake completes, then drain as `turn/start` /
 *     `turn/steer` dispatches through the channel sink)
 *   - the `reject-new` second-bridge policy (codex spawns one bridge
 *     per thread, including subagents; the root's bridge stays pinned)
 *   - `spawnCodex` — ephemeral CODEX_HOME, JSON-RPC handshake,
 *     rollout/bundle capture readers
 *   - the headless operator banner (thread id + `csuite push` hint)
 *     and the HUD strip
 *
 * Lifecycle (signals, teardown ordering, run summary) is inherited
 * from `runAgentSession`. Codex runs headless — the runner owns the
 * terminal — so the adapter declares `signals: 'teardown'`: Ctrl-C
 * ends the session gracefully rather than being forwarded.
 */

import { existsSync, promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CompactAttempt } from '../../context-control.js';
import type { ChannelEvent, ChannelEventSink } from '../../forwarder.js';
import { type HudHandle, startHud } from '../../hud.js';
import type {
  AgentAdapter,
  AgentAdapterMeta,
  AgentDoctorCheck,
  AgentPrepared,
  AgentProcess,
  AgentSessionContext,
  RespawnPosture,
} from '../adapter.js';
import { type CodexCompactOutcome, findCodexBinary, spawnCodex } from './adapter.js';

/**
 * uid-0 posture. Codex has no root refusal — it runs with sandbox
 * `danger-full-access` regardless — so uid 0 is a WARN, never a FAIL:
 * the session works, but nothing contains it, and every file it
 * touches is root-owned.
 */
function codexRootCheck(): AgentDoctorCheck {
  const name = 'not running as root';
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid === null) {
    return {
      name,
      status: 'WARN',
      detail: 'no effective uid on this platform — cannot verify the session user',
    };
  }
  if (uid !== 0) {
    return { name, status: 'PASS', detail: `uid ${uid}` };
  }
  const sudoUser = process.env.SUDO_USER;
  const sudoPart =
    sudoUser !== undefined && sudoUser !== '' && sudoUser !== 'root'
      ? ` Drop the sudo to run as ${sudoUser}.`
      : '';
  return {
    name,
    status: 'WARN',
    detail:
      'uid 0 — codex runs with sandbox danger-full-access, and as root nothing ' +
      'contains it: every file it creates is root-owned and system-wide writes ' +
      `succeed.${sudoPart}`,
  };
}

/** Linux tmpfs f_type, per statfs(2). */
const TMPFS_MAGIC = 0x01021994;

/**
 * Codex stages apply-patch work under its cache dir. A RAM-backed
 * cache silently erases it on reboot or memory pressure, which
 * surfaces as "codex lost my patch" long after the cause. The named
 * dir often does not exist yet on a cold machine, so the probe walks
 * up to the nearest existing ancestor — the filesystem the dir WILL
 * be created on is the one that answers.
 */
async function codexCacheCheck(): Promise<AgentDoctorCheck> {
  const name = 'codex cache dir not tmpfs';
  const configured = process.env.XDG_CACHE_HOME;
  const cacheDir =
    configured !== undefined && configured !== '' ? configured : join(homedir(), '.cache');
  let probe = cacheDir;
  let hops = 0;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe || ++hops > 64) break;
    probe = parent;
  }
  try {
    const stats = await fs.statfs(probe);
    if (stats.type === TMPFS_MAGIC) {
      return {
        name,
        status: 'WARN',
        detail:
          `${cacheDir} is RAM-backed (tmpfs) — codex stages apply-patch work ` +
          'under its cache, and a reboot or memory pressure erases it. Point ' +
          '$XDG_CACHE_HOME at disk.',
      };
    }
    const via = probe === cacheDir ? cacheDir : `via existing parent ${probe}`;
    return { name, status: 'PASS', detail: `${cacheDir} is disk-backed (${via})` };
  } catch (err) {
    return {
      name,
      status: 'WARN',
      detail: `could not stat ${probe}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export const CODEX_META: AgentAdapterMeta = {
  id: 'codex',
  displayName: 'OpenAI Codex',
  // Tier 3: rollout-primary content capture + operational OTEL +
  // gen_ai trace bundles (verbatim Responses payloads). See
  // docs/runners/conformance.mdx for the tier definitions.
  captureTier: 3,
  signals: 'teardown',
  // No declared range yet — the doctor reports the detected version
  // without judging it.
  testedVersions: null,
  versionArgs: ['--version'],
};

export interface CodexAdapterOptions {
  /** Optional model override forwarded as `thread/start`'s `model`. */
  model?: string;
  /**
   * Resume a previous codex thread instead of starting fresh. A string
   * is a thread id; `true` resumes this member's most recent thread on
   * this machine.
   */
  resume?: string | true;
  /** Extra args forwarded verbatim to `codex app-server`. */
  codexArgs?: string[];
}

export function createCodexAdapter(options: CodexAdapterOptions): AgentAdapter {
  let codexBinary = '';

  // What resume posture the NEXT spawn uses. Starts as the operator's
  // choice; respawn() overrides it with the predecessor's thread id.
  // A full re-spawn per generation is sound for codex because the
  // sessions dir is durable OUTSIDE the ephemeral CODEX_HOME (each
  // home symlinks it in), so tearing one home down and resuming from
  // a fresh one loses nothing.
  let effectiveResume: string | true | undefined = options.resume;

  // Buffering channel sink. The runner needs a sink up front, but the
  // codex channel sink can't exist until after spawnCodex creates the
  // JSON-RPC client. Events queue until the real sink is attached,
  // then drain in order.
  //
  // Why a queue (not a drop): the broker's subscription replays
  // any unread messages immediately on connect. Codex cold-start
  // (plugin sync, model refresh) takes 5-15s, and during that window
  // the forwarder is already receiving events. Dropping them silently
  // meant the agent missed the very first messages in its inbox —
  // including any DM addressed at it that arrived while it was
  // offline. The queue closes that gap.
  let liveSink: ChannelEventSink | null = null;
  // The current generation's compaction actuator, or null before the
  // first spawn / between a stop and its successor.
  let liveCompact: ((timeoutMs?: number) => Promise<CodexCompactOutcome>) | null = null;
  const pendingEvents: ChannelEvent[] = [];
  const sinkWrapper: ChannelEventSink = {
    async deliver(event) {
      if (liveSink === null) {
        pendingEvents.push(event);
        return;
      }
      await liveSink.deliver(event);
    },
  };

  const adapter: AgentAdapter = {
    meta: CODEX_META,

    locate(): void {
      codexBinary = findCodexBinary();
    },

    binaryPath(): string | null {
      return codexBinary.length > 0 ? codexBinary : null;
    },

    runnerOptions() {
      return {
        channelSink: sinkWrapper,
        // Codex spawns a fresh `csuite mcp-bridge` per thread — including
        // every subagent it dispatches. Those extra bridges would displace
        // the root thread's bridge under the default `displace-old`,
        // breaking the root agent's csuite tools (the "Transport closed"
        // failure). `reject-new` keeps the root's bridge pinned and refuses
        // subagent bridges instead: subagents stay off the net (no inbound
        // notifications, no gaggle) and simply have no csuite tools, while
        // the root agent keeps sending and receiving normally.
        onSecondBridge: 'reject-new' as const,
      };
    },

    prepare(): AgentPrepared {
      // Codex writes nothing outside its own ephemeral CODEX_HOME, and
      // that home is created + destroyed by spawnCodex/shutdown — no
      // operator files to back up or restore.
      return { cleanup: () => {} };
    },

    async spawn(ctx: AgentSessionContext): Promise<AgentProcess> {
      const { runner, log } = ctx;
      const spawned = await spawnCodex({
        instructions: runner.instructions,
        runnerSocketPath: runner.socketPath,
        bridgeCommand: ctx.bridgeCommand,
        bridgeArgs: [...ctx.bridgeArgs],
        captureHost: runner.captureHost,
        secretsEnv: runner.secretsEnv,
        codexBinary,
        cwd: ctx.cwd,
        model: options.model,
        resume: effectiveResume,
        codexArgs: options.codexArgs,
        presence: ctx.presence,
        // Share the capture host's busy signal so codex tool-lifecycle
        // notifications feed the same observable claude's hooks drive.
        // Undefined when --no-trace.
        busy: runner.captureHost?.busy,
        // Codex reports compaction (requested or auto) as a
        // contextCompaction item; that is this framework's equivalent
        // of claude's SessionStart(source=compact) hook, so it drives
        // the same plate re-assertion.
        onCompacted: () => runner.rebrief('context-compaction'),
        logger: log,
      });

      // The compaction actuator follows the live generation: a restart
      // or clear swaps this so a control never reaches the process it
      // replaced.
      liveCompact = (timeoutMs) => spawned.compact(timeoutMs);

      // Attach the live sink and drain anything the forwarder queued
      // while codex was cold-starting.
      liveSink = spawned.channelSink;
      if (pendingEvents.length > 0) {
        log.info('draining pre-attach broker queue', { queued: pendingEvents.length });
        const drain = pendingEvents.splice(0, pendingEvents.length);
        for (const event of drain) {
          try {
            await spawned.channelSink.deliver(event);
          } catch (err) {
            log.warn('drain delivery failed', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      // Surface the thread id so the operator can pick this session
      // back up later — the codex analogue of claude's session id.
      const threadId = spawned.getThreadId();
      process.stderr.write(
        (threadId
          ? `csuite codex: thread ${threadId}${effectiveResume ? ' (resumed)' : ''} — pick it up later with: csuite codex --resume ${threadId}\n`
          : '') +
          `csuite codex: agent connected — Ctrl-C to stop. Direct it via the broker:\n` +
          `    csuite push --agent ${runner.instructions.name} --body "your instructions"\n\n`,
      );

      // HUD strip — same chrome as `csuite claude` (2-row footer
      // pinned to the bottom showing `csuite · ● <state>` + agent name).
      // For codex the value is even higher than for claude: the
      // agent emits no terminal output of its own, so without the
      // strip a long-idle session looks identical to a hung one.
      //
      // `reserveBottomSpace: true` is essential here. Our prior
      // stderr banners scrolled the terminal so the cursor sits at the
      // bottom row; if we let `startHud` set the scroll region without
      // reserving first, the cursor lands *outside* the region and the
      // activity printer's writes paint over the HUD strip instead of
      // scrolling above it. claude doesn't need this because
      // claude enters the alternate screen buffer first.
      //
      // `redraw()` once explicitly: the HUD defers its first render
      // until the caller asks (so it doesn't interleave with a tty
      // handshake), and for codex there's no PTY relay to drive it.
      // A no-op when stdout isn't a TTY.
      const hud: HudHandle = startHud({
        presence: ctx.presence,
        label: `csuite codex · ${runner.instructions.name}`,
        reserveBottomSpace: true,
        logger: log,
      });
      hud.redraw();

      let shutdownDone = false;
      return {
        exitCode: spawned.exitCode,
        sessionId: () => spawned.getThreadId(),
        async shutdown(reason) {
          if (shutdownDone) return;
          shutdownDone = true;
          // Close the HUD first so its DECSTBM scroll-region is released
          // before shutdown chatter scrolls. Otherwise the final teardown
          // lines would scroll *within* the region and leave the strip
          // visually stranded on top of new prompt text.
          hud.close();
          await spawned.shutdown(reason);
        },
      };
    },

    detachForRestart(): void {
      // Drop the outgoing generation's compaction actuator with its
      // sink. A control landing during the swap must not be answered
      // by the process being replaced.
      liveCompact = null;
      // Back to the pre-attach buffer: events queue until the
      // successor's spawn attaches its live sink — the same mechanism
      // that already covers codex's 5-15s cold start.
      liveSink = null;
    },

    async respawn(ctx: AgentSessionContext, prior: RespawnPosture): Promise<AgentProcess> {
      if (!prior.resume) {
        // A `clear`. `undefined` makes the next spawn open a NEW thread
        // (`thread/start`) instead of resuming one — note that `true`
        // here would mean "most recent thread on this machine", which
        // is the opposite of what a clear wants and is exactly the trap
        // the RespawnPosture union exists to close.
        effectiveResume = undefined;
        ctx.log.info('respawning cold — conversation dropped by context clear');
        return adapter.spawn(ctx);
      }
      // `sessionId` is the codex thread id. `true` (most recent thread
      // on this machine) when the predecessor never revealed one.
      effectiveResume = prior.sessionId ?? true;
      ctx.log.info('respawning with refreshed instructions', {
        resume: effectiveResume,
      });
      return adapter.spawn(ctx);
    },

    // `reason` is accepted and deliberately unused — see below.
    async compactContext(_reason: string | undefined): Promise<CompactAttempt> {
      if (liveCompact === null) {
        // Not `unsupported` — the runner CAN compact, there is just no
        // live thread to compact right now. Conflating the two would
        // tell a caller to stop asking forever over a transient state.
        return {
          supported: true,
          applied: false,
          detail: 'no codex thread is running yet',
        };
      }
      // `reason` has nowhere to go: `thread/compact/start` takes only
      // `{ threadId }`, with no field for custom summarisation
      // instructions (claude's `/compact <reason>` accepts them). It
      // still reaches the operator through the activity ack, so the
      // request is explicable even though it did not steer the summary.
      const outcome = await liveCompact();
      return outcome.applied
        ? { supported: true, applied: true }
        : { supported: true, applied: false, detail: outcome.detail };
    },

    async doctor(): Promise<AgentDoctorCheck[]> {
      return [codexRootCheck(), await codexCacheCheck()];
    },
  };
  return adapter;
}
