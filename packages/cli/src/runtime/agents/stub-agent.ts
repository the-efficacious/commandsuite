/**
 * Stub AgentAdapter — `csuite stub` — a test/CI instrument, never a
 * member you would deploy.
 *
 * It exists so an environment with no model credential (CI, a fresh
 * container) can observe the runner lifecycle END-TO-END: presence
 * reaching `connected=1`, the `session_start` activity bracket, the
 * MCP bridge attaching, restart/clear/reload respawns, and a clean
 * exit. There is no model anywhere: when addressed in a DM the stub
 * answers ONE canned, self-identifying line through the same path a
 * real agent uses (an MCP `send` tool call through the bridge), and
 * otherwise it does nothing.
 *
 * Visibility contract (obj-mtfqnm28-f, ruled by Lea 2026-08-30): the
 * stub names itself in four places with no wire change — the
 * `session_start` activity carries `runner: 'stub'`; the CI jobs enrol
 * the member with a title naming it a stub; the doctor prints the
 * instrument line below; and the canned turn self-identifies. Keep all
 * four when changing this file.
 *
 * Deliberate non-features: no `compactContext` (the coordinator
 * reports `unsupported`, which is the honest answer — there is no
 * conversation to summarise), no binary (`locate()` has nothing to
 * find; `versionArgs: null` skips the version probe).
 */

import { randomUUID } from 'node:crypto';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ChannelEvent, ChannelEventSink } from '../forwarder.js';
import type {
  AgentAdapter,
  AgentAdapterMeta,
  AgentDoctorCheck,
  AgentLog,
  AgentProcess,
  AgentSessionContext,
  RespawnPosture,
} from './adapter.js';

export const STUB_META: AgentAdapterMeta = {
  id: 'stub',
  displayName: 'Stub agent (CI instrument)',
  // Tier 1: the run bracket (session_start/session_end) is the only
  // capture content a stub can honestly produce — there is no model,
  // no transcript, no tool stream. See docs/runners/conformance.mdx.
  captureTier: 1,
  signals: 'teardown',
  testedVersions: null,
  versionArgs: null,
};

/** How the stub decides a channel event is addressed to the member. */
export function isAddressedDm(event: ChannelEvent, member: string): boolean {
  if (event.meta.thread !== 'dm') return false;
  // The forwarder stamps `target` for DMs; a missing target on a dm
  // event still means "delivered to this member's stream".
  return event.meta.target === undefined || event.meta.target === member;
}

export function cannedReply(member: string): string {
  return (
    `I am ${member}'s stub runner — a CI test instrument (csuite stub), not a deployable ` +
    'member. This is a canned reply proving the runner lifecycle end to end; a real agent ' +
    'would answer here.'
  );
}

/**
 * One generation of the stub "agent": an in-process AgentProcess that
 * connects the real MCP bridge subprocess (the same `csuite mcp-bridge`
 * a real agent's framework would spawn) and answers addressed DMs with
 * the canned line, once per DM, serialized.
 */
export interface StubBridge {
  /** Send the canned reply to one member (an MCP `send` tool call). */
  send(to: string, body: string): Promise<void>;
  close(): Promise<void>;
}

/** The real bridge: `csuite mcp-bridge` over stdio, like a real agent. */
async function connectStubBridge(ctx: AgentSessionContext): Promise<StubBridge> {
  const transport = new StdioClientTransport({
    command: ctx.bridgeCommand,
    args: [...ctx.bridgeArgs],
    env: {
      ...(process.env as Record<string, string>),
      CSUITE_RUNNER_SOCKET: ctx.runner.socketPath,
    },
  });
  const client = new McpClient({ name: 'csuite-stub-agent', version: '0.0.0' });
  await client.connect(transport);
  return {
    async send(to, body) {
      await client.callTool({ name: 'send', arguments: { to, body } });
    },
    async close() {
      await client.close();
    },
  };
}

export class StubProcess implements AgentProcess {
  readonly exitCode: Promise<number>;
  private settle!: (code: number) => void;
  private readonly id = randomUUID();
  private closed = false;
  private replyChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly bridge: StubBridge,
    private readonly member: string,
    private readonly log: AgentLog,
  ) {
    this.exitCode = new Promise<number>((resolve) => {
      this.settle = resolve;
    });
  }

  /** Deliver one channel event; an addressed DM earns the canned turn. */
  deliver(event: ChannelEvent): void {
    if (this.closed || !isAddressedDm(event, this.member)) return;
    const to = event.meta.from;
    if (!to || to === this.member) return;
    // Serialized so a burst of DMs cannot interleave tool calls; each
    // DM gets exactly one reply, errors are logged and never fatal —
    // a stub that crashes on a malformed event would fail the very
    // lifecycle observation it exists to provide.
    this.replyChain = this.replyChain.then(async () => {
      try {
        await this.bridge.send(to, cannedReply(this.member));
        this.log.info('stub answered a DM with the canned turn', { to });
      } catch (err) {
        this.log.warn('stub canned reply failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  sessionId(): string | null {
    return this.id;
  }

  /**
   * Test/CI knob: end this generation on its own after `ms`, exiting
   * with `code`. The conformance kit deliberately avoids process
   * signals, and a stub never exits by itself otherwise — this is the
   * bounded-run form (`CSUITE_STUB_EXIT_AFTER_MS`/`CSUITE_STUB_EXIT_CODE`).
   */
  armTestExit(ms: number, code: number): void {
    const timer = setTimeout(() => {
      void this.close(code);
    }, ms);
    timer.unref?.();
  }

  sessionEnded(): boolean {
    return this.closed;
  }

  async shutdown(): Promise<void> {
    await this.close(0);
  }

  private async close(code: number): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.replyChain.catch(() => {});
    try {
      await this.bridge.close();
    } catch {
      // Bridge already gone — teardown order is not guaranteed.
    }
    this.settle(code);
  }
}

/**
 * Sink shared across generations: buffers while no generation is live
 * (cold start, mid-restart) and hands events to the current one. The
 * driver's `detachForRestart()` flips delivery back to the buffer.
 */
export class StubSink implements ChannelEventSink {
  private current: StubProcess | null = null;
  private buffer: ChannelEvent[] = [];

  attach(proc: StubProcess): void {
    this.current = proc;
    const held = this.buffer;
    this.buffer = [];
    for (const event of held) proc.deliver(event);
  }

  detach(): void {
    this.current = null;
  }

  deliver(event: ChannelEvent): Promise<void> {
    if (this.current) this.current.deliver(event);
    else this.buffer.push(event);
    return Promise.resolve();
  }
}

export function createStubAdapter(): AgentAdapter {
  const sink = new StubSink();

  const spawnGeneration = async (ctx: AgentSessionContext): Promise<AgentProcess> => {
    const member = ctx.runner.instructions.name;
    const proc = new StubProcess(await connectStubBridge(ctx), member, ctx.log);
    sink.attach(proc);
    const exitAfter = Number(process.env.CSUITE_STUB_EXIT_AFTER_MS ?? Number.NaN);
    if (Number.isFinite(exitAfter) && exitAfter > 0) {
      proc.armTestExit(exitAfter, Number(process.env.CSUITE_STUB_EXIT_CODE ?? '0') || 0);
    }
    ctx.log.info('stub agent generation live', { member });
    return proc;
  };

  const adapter: AgentAdapter = {
    meta: STUB_META,

    locate(): void {
      // Nothing to locate: the stub is in-process. Deliberately not an
      // absent-by-design error — the stub is always runnable.
    },

    binaryPath(): string | null {
      return null;
    },

    runnerOptions() {
      return { channelSink: sink };
    },

    prepare() {
      return {
        cleanup() {
          // Nothing written anywhere: nothing to undo.
        },
        bannerLines: [
          'stub agent — test/CI instrument, never a deployable member.',
          'It reports presence, attaches the MCP bridge, and answers DMs with one canned line.',
        ],
      };
    },

    spawn: spawnGeneration,

    detachForRestart(): void {
      sink.detach();
    },

    async respawn(ctx: AgentSessionContext, prior: RespawnPosture): Promise<AgentProcess> {
      // A stub holds no conversation, so resume-vs-cold differ only in
      // the log line; both honour the contract (predecessor fully shut
      // down, current instructions re-read inside spawn).
      ctx.log.info(prior.resume ? 'stub respawn (resume posture)' : 'stub respawn (cold, clear)', {
        priorSession: prior.resume ? prior.sessionId : null,
      });
      return spawnGeneration(ctx);
    },

    async doctor(): Promise<AgentDoctorCheck[]> {
      return [
        {
          name: 'stub instrument',
          status: 'WARN',
          detail:
            'this is the stub agent — a test/CI instrument that proves runner lifecycle ' +
            'without a model credential; never deploy it as a team member',
        },
      ];
    },
  };
  return adapter;
}
