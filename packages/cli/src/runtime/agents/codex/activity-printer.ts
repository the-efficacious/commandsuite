/**
 * Codex activity printer — renders codex's JSON-RPC notification stream
 * as human-readable lines on a write stream (default `process.stderr`).
 *
 * Codex's `app-server` is silent on the wire: it speaks JSON-RPC over
 * stdio and emits no terminal UI of its own. Without this module the
 * operator running `csuite codex` sees a startup banner and then nothing
 * — even while the agent is working. The session log captures the
 * structured events, but you have to know to tail it. That's a much
 * worse experience than `csuite claude-code`, where claude paints its own
 * ink TUI inside our pty relay.
 *
 * What this prints (per turn the agent runs):
 *
 *   ↻ thread 7f2a87e1 started
 *
 *   ▸ turn 8a3f
 *      $ ls packages/cli/src
 *      ± edit packages/cli/src/runtime/foo.ts
 *      → mcp: csuite.send_message
 *      assistant: Found the issue. The shape of the merge in…
 *      └─ done · 1.2s · 3 tools
 *
 * Streaming assistant prose lands via `item/agentMessage/delta`
 * notifications — we open the `assistant:` line on the first delta and
 * append each delta directly so the text appears as the model emits it.
 * Newlines inside a delta are re-indented to stay under the turn block.
 * If a codex build skips delta streaming and only sends the completed
 * item, the full `text` field is printed in one shot — same output, no
 * branching for the consumer.
 *
 * Item field shapes mirror codex's
 * `app-server-protocol/src/protocol/v2/item.rs` `ThreadItem` enum —
 * verified against the upstream source. Field access is defensive
 * (each item is `unknown` at the wire boundary): missing or unexpected
 * fields fall through to a type-only line rather than throwing.
 *
 * Output:
 *   - ANSI 24-bit colors when `stream.isTTY` (palette matches
 *     `runtime/hud.ts` so the printer reads as the same chrome).
 *   - Plain ASCII when not a TTY — CI logs stay grep-friendly.
 */

import type { JsonRpcClient } from './json-rpc.js';
import {
  type AgentMessageDeltaNotification,
  type ErrorNotification,
  type ItemCompletedNotification,
  type ItemStartedNotification,
  NOTIFICATIONS,
  type ThreadStartedNotification,
  type TurnCompletedNotification,
  type TurnStartedNotification,
} from './protocol.js';

// ── Palette (matches runtime/hud.ts; same hexes as web theme) ────────

const CSI = '\x1b[';
const RESET = `${CSI}0m`;
function rgb(r: number, g: number, b: number): string {
  return `${CSI}38;2;${r};${g};${b}m`;
}
const PALETTE = {
  steel: rgb(0x3e, 0x5c, 0x76), // brand-load-bearing
  glacier: rgb(0x63, 0x89, 0xa6), // accent
  frost: rgb(0xa4, 0xbd, 0xd1), // agent / assistant prefix
  muted: rgb(0x7b, 0x85, 0x91), // chrome glyphs
  ember: rgb(0xc8, 0x7c, 0x4e), // error / alert
  ink: rgb(0xe3, 0xeb, 0xf2), // body text
};

// Indent used under a turn block — three spaces lines up with the
// ▸ glyph + space + short turn id, leaving content aligned.
const INDENT = '   ';

export interface ActivityPrinterOptions {
  rpc: JsonRpcClient;
  /**
   * Where to write activity lines. Defaults to `process.stderr`.
   * Stderr (not stdout) by convention — stdout is reserved for
   * programmatic output, and the operator running `csuite codex` is
   * watching the same terminal anyway.
   */
  stream?: NodeJS.WriteStream;
  /**
   * Force color on/off. Defaults to `stream.isTTY`: TTY → colored
   * ANSI, non-TTY → plain ASCII. Tests pin to `false` for stable
   * string comparison.
   */
  color?: boolean;
  /** Diagnostic logger (session log). Defaults to a no-op. */
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
}

export interface ActivityPrinter {
  /**
   * Flush any pending in-flight assistant-delta line (close it with a
   * newline) and stop subscribing. Idempotent.
   */
  close(): void;
}

interface TurnState {
  startedAtMs: number;
  toolCount: number;
}

export function attachCodexActivityPrinter(options: ActivityPrinterOptions): ActivityPrinter {
  const stream = options.stream ?? process.stderr;
  const color = options.color ?? Boolean(stream.isTTY);
  const log = options.log ?? (() => {});

  // Wrap with color codes only when enabled. Wrapping inline keeps
  // each formatter readable instead of forking the whole function on
  // a color boolean.
  const paint = (code: string, text: string): string => (color ? `${code}${text}${RESET}` : text);
  const write = (s: string): void => {
    stream.write(s);
  };

  // Per-turn metrics. Keyed by turnId so an overlapping or out-of-order
  // turn boundary doesn't lose its start timestamp to a sibling.
  const turns = new Map<string, TurnState>();

  // True while we're mid-line writing streamed assistant deltas — the
  // matching `item/completed` closes the line. Track the open item id
  // so a delta belonging to a *different* agentMessage (rare, but the
  // schema allows multiple) doesn't append into the wrong block.
  let openDeltaItemId: string | null = null;
  const ensureDeltaLineOpen = (itemId: string): void => {
    if (openDeltaItemId === itemId) return;
    if (openDeltaItemId !== null) {
      // Previous assistant block never got its completion event — flush
      // it cleanly before opening a new one.
      write('\n');
    }
    openDeltaItemId = itemId;
    write(`${INDENT}${paint(PALETTE.frost, 'assistant:')} `);
  };
  const closeDeltaLine = (): void => {
    if (openDeltaItemId === null) return;
    write('\n');
    openDeltaItemId = null;
  };

  // Tool-class items the busy sniff already counts; we mirror the set
  // for the per-turn `N tools` summary so the two read consistently.
  const TOOL_TYPES: ReadonlySet<string> = new Set([
    'commandExecution',
    'fileChange',
    'mcpToolCall',
    'dynamicToolCall',
    'webSearch',
  ]);

  // ── Notification handlers ──────────────────────────────────────

  options.rpc.onNotification(NOTIFICATIONS.threadStarted, (params) => {
    const p = params as ThreadStartedNotification;
    const id = p?.thread?.id ?? '';
    write(`${paint(PALETTE.muted, '↻')} thread ${paint(PALETTE.glacier, shortId(id))} started\n\n`);
  });

  options.rpc.onNotification(NOTIFICATIONS.turnStarted, (params) => {
    const p = params as TurnStartedNotification;
    const id = p?.turn?.id ?? '';
    turns.set(id, { startedAtMs: Date.now(), toolCount: 0 });
    closeDeltaLine();
    write(`${paint(PALETTE.steel, '▸')} turn ${paint(PALETTE.glacier, shortId(id))}\n`);
  });

  options.rpc.onNotification(NOTIFICATIONS.turnCompleted, (params) => {
    const p = params as TurnCompletedNotification;
    const id = p?.turn?.id ?? '';
    closeDeltaLine();
    const state = turns.get(id);
    if (state) {
      const elapsed = formatElapsed(Date.now() - state.startedAtMs);
      const noun = state.toolCount === 1 ? 'tool' : 'tools';
      write(
        `${INDENT}${paint(PALETTE.muted, `└─ done · ${elapsed} · ${state.toolCount} ${noun}`)}\n\n`,
      );
      turns.delete(id);
    } else {
      write(`${INDENT}${paint(PALETTE.muted, '└─ done')}\n\n`);
    }
  });

  options.rpc.onNotification(NOTIFICATIONS.itemStarted, (params) => {
    const p = params as ItemStartedNotification;
    if (!p?.item?.type) return;
    if (TOOL_TYPES.has(p.item.type)) {
      const state = p.turnId ? turns.get(p.turnId) : null;
      if (state) state.toolCount++;
    }
    const line = formatItemStarted(p.item);
    if (line === null) return;
    closeDeltaLine();
    write(`${INDENT}${line}\n`);
  });

  options.rpc.onNotification(NOTIFICATIONS.itemCompleted, (params) => {
    const p = params as ItemCompletedNotification;
    const item = p?.item;
    if (!item?.type) return;

    if (item.type === 'agentMessage') {
      const itemId = typeof item.id === 'string' ? item.id : null;
      if (itemId !== null && openDeltaItemId === itemId) {
        // Stream already painted the body — just close it.
        closeDeltaLine();
        return;
      }
      // No deltas arrived (codex returned the message in one shot).
      // Open + close a single line carrying the full text.
      const text = strField(item, 'text');
      if (text !== null && text.length > 0) {
        if (itemId !== null) ensureDeltaLineOpen(itemId);
        write(indentContinuation(text));
        closeDeltaLine();
      }
      return;
    }

    // Completion-time annotations for the tool items: command exit
    // codes and durations. Started already drew the headline line; we
    // only re-print when there's something the operator should notice.
    const completionLine = formatItemCompleted(item);
    if (completionLine !== null) {
      closeDeltaLine();
      write(`${INDENT}${completionLine}\n`);
    }
  });

  options.rpc.onNotification(NOTIFICATIONS.agentMessageDelta, (params) => {
    const p = params as AgentMessageDeltaNotification;
    if (!p?.itemId || typeof p.delta !== 'string' || p.delta.length === 0) return;
    ensureDeltaLineOpen(p.itemId);
    write(indentContinuation(p.delta));
  });

  options.rpc.onNotification(NOTIFICATIONS.error, (params) => {
    const p = params as ErrorNotification;
    // 0.130.0 nests the text under `error.message` (a TurnError); older
    // builds inlined a top-level `message`. Prefer the nested one.
    const msg = strField(p.error, 'message') ?? strField(p, 'message') ?? '(no message)';
    closeDeltaLine();
    write(`${paint(PALETTE.ember, '! error:')} ${msg}\n`);
    log('codex-activity-printer: error notification surfaced', { message: msg });
  });

  options.rpc.onNotification(NOTIFICATIONS.warning, (params) => {
    const msg = strField(params, 'message') ?? '(no message)';
    closeDeltaLine();
    write(`${paint(PALETTE.muted, '! warn:')} ${msg}\n`);
  });

  let closed = false;
  return {
    close(): void {
      if (closed) return;
      closed = true;
      // A still-open assistant block at teardown means codex was
      // streaming when we shut down. Close the line so the terminal
      // doesn't end on a half-painted row.
      closeDeltaLine();
    },
  };

  // ── Per-item formatters ────────────────────────────────────────

  function formatItemStarted(item: { type: string; [k: string]: unknown }): string | null {
    switch (item.type) {
      case 'commandExecution': {
        const cmd = strField(item, 'command') ?? '(command)';
        return `${paint(PALETTE.muted, '$')} ${paint(PALETTE.ink, oneLine(cmd))}`;
      }
      case 'fileChange': {
        const changes = arrField(item, 'changes');
        const paths = changes
          ? changes
              .map((c) => strField(c, 'path') ?? pathFromUpdate(c))
              .filter((p): p is string => p !== null)
          : [];
        const body =
          paths.length === 0
            ? '(file change)'
            : paths.length === 1
              ? (paths[0] as string)
              : `${paths.length} files`;
        return `${paint(PALETTE.muted, '±')} ${paint(PALETTE.ink, body)}`;
      }
      case 'mcpToolCall': {
        const server = strField(item, 'server') ?? '?';
        const tool = strField(item, 'tool') ?? '?';
        return `${paint(PALETTE.muted, '→')} mcp: ${paint(PALETTE.ink, `${server}.${tool}`)}`;
      }
      case 'dynamicToolCall': {
        const ns = strField(item, 'namespace');
        const tool = strField(item, 'tool') ?? '?';
        const name = ns ? `${ns}.${tool}` : tool;
        return `${paint(PALETTE.muted, '→')} tool: ${paint(PALETTE.ink, name)}`;
      }
      case 'webSearch': {
        const q = strField(item, 'query') ?? '';
        return `${paint(PALETTE.muted, '?')} search: ${paint(PALETTE.ink, oneLine(q))}`;
      }
      case 'agentMessage':
        // Deltas open the line themselves on first text; nothing to
        // print at item/started time. Avoids an empty `assistant:`
        // prefix when the model produces only a tool-use turn.
        return null;
      case 'reasoning':
        // Reasoning content arrives on completion. Skipping at start
        // keeps the per-turn flow uncluttered — the assistant message
        // that follows is the user-facing artifact.
        return null;
      case 'userMessage':
      case 'hookPrompt':
        // We dispatched these (turn/start / turn/steer) — printing
        // them back would just echo the operator's own broker input.
        return null;
      default:
        return paint(PALETTE.muted, `· ${item.type}`);
    }
  }

  function formatItemCompleted(item: { type: string; [k: string]: unknown }): string | null {
    if (item.type === 'commandExecution') {
      const exit = numField(item, 'exitCode');
      // Only surface non-zero exits; success is the silent default.
      if (exit !== null && exit !== 0) {
        const dur = numField(item, 'durationMs');
        const suffix = dur !== null ? ` · ${formatElapsed(dur)}` : '';
        return paint(PALETTE.ember, `  ↳ exit ${exit}${suffix}`);
      }
    }
    if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') {
      // Codex sets `error` on tool failures; flag those so the user
      // doesn't have to grep the session log for them.
      const error = (item as Record<string, unknown>).error;
      if (error) {
        const msg = strField(error, 'message') ?? 'tool error';
        return paint(PALETTE.ember, `  ↳ ${oneLine(msg)}`);
      }
    }
    return null;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Short-form id for the turn / thread badge. Codex ids are long random
 * strings; the first 8 chars are plenty for human disambiguation and
 * keep the line short enough to scan.
 */
function shortId(id: string): string {
  if (id.length <= 8) return id;
  return id.slice(0, 8);
}

/**
 * Indent every continuation line inside `text` to match the per-turn
 * indent. Used for streaming assistant deltas: codex emits raw model
 * output which can include `\n`s mid-paragraph, and without re-indent
 * the second line would slam against the left edge and visually escape
 * the turn block.
 */
function indentContinuation(text: string): string {
  return text.replace(/\n/g, `\n${INDENT}`);
}

/** Collapse newlines + runs of whitespace so a multi-line command renders as one line. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds - m * 60);
  return `${m}m${s}s`;
}

function strField(o: unknown, k: string): string | null {
  if (o && typeof o === 'object' && k in o) {
    const v = (o as Record<string, unknown>)[k];
    if (typeof v === 'string') return v;
  }
  return null;
}

function numField(o: unknown, k: string): number | null {
  if (o && typeof o === 'object' && k in o) {
    const v = (o as Record<string, unknown>)[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

function arrField(o: unknown, k: string): unknown[] | null {
  if (o && typeof o === 'object' && k in o) {
    const v = (o as Record<string, unknown>)[k];
    if (Array.isArray(v)) return v;
  }
  return null;
}

/**
 * Pull a path out of a `FileUpdateChange`, which codex shapes as a
 * tagged-union over (add | delete | update | rename). The path lives
 * under a few different field names depending on the variant; this
 * walks them in order and returns the first hit.
 */
function pathFromUpdate(c: unknown): string | null {
  return (
    strField(c, 'path') ??
    strField(c, 'targetPath') ??
    strField(c, 'newPath') ??
    strField(c, 'oldPath')
  );
}
