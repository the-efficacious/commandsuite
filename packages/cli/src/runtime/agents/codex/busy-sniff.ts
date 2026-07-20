/**
 * Drive a `BusySignal` from codex app-server JSON-RPC notifications.
 *
 * Subscribes to `item/started`, `item/completed`, and `turn/completed`
 * on the supplied JSON-RPC client and bumps `tool_inflight` for
 * tool-execution items. Reused by `spawnCodex` and the busy-sniff
 * test so the contract under test is the same one production runs.
 *
 * Returns a `drain()` callback the caller should invoke on teardown:
 * codex won't send matching `item/completed` events for items still
 * in flight when we close, so any leftover busy handles need an
 * explicit drain to avoid wedging the indicator.
 */

import type { BusySignal } from '../../trace/busy.js';
import type { JsonRpcClient } from './json-rpc.js';
import {
  type ItemCompletedNotification,
  type ItemStartedNotification,
  NOTIFICATIONS,
} from './protocol.js';

/**
 * Codex item types that represent agent-side WORK (not model output,
 * not user input, not metadata). Lighting up `tool_inflight` for these
 * gives the UI a "the agent is running something locally" signal that
 * the LLM-call busy bump would otherwise miss.
 *
 * `commandExecution` covers Bash; `fileChange` covers apply_patch /
 * file edits; `mcpToolCall` covers MCP-bridged tool dispatch. New
 * codex item types default to "not a tool" — better to under-bump
 * than to falsely light up busy on, say, an `agentMessage` (model
 * output, already covered by the LLM-call bump).
 */
export const TOOL_ITEM_TYPES: ReadonlySet<string> = new Set([
  'commandExecution',
  'fileChange',
  'mcpToolCall',
]);

export interface CodexBusySniffOptions {
  rpc: JsonRpcClient;
  busy: BusySignal;
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
}

export interface CodexBusySniff {
  /**
   * Drain any handles still in flight. Safe to call multiple times —
   * second call is a no-op since the underlying map is empty after
   * the first.
   */
  drain(): void;
  /**
   * Outstanding tool handle count. Useful for assertions.
   */
  readonly inFlight: number;
}

export function attachCodexBusySniff(options: CodexBusySniffOptions): CodexBusySniff {
  const { rpc, busy } = options;
  const log = options.log ?? (() => {});

  // Per-item busy handles, keyed by item.id. Codex's `item/completed`
  // notifications are normally reliable, but a turn interrupt or
  // transport error can drop them; the turnCompleted handler below
  // sweeps any leftovers so busy can't stay wedged.
  const toolHandles = new Map<string, { finish: () => void }>();

  const drainAll = (reason: string): void => {
    if (toolHandles.size === 0) return;
    log('codex-busy-sniff: draining tool handles', { count: toolHandles.size, reason });
    for (const handle of toolHandles.values()) handle.finish();
    toolHandles.clear();
  };

  rpc.onNotification(NOTIFICATIONS.itemStarted, (params) => {
    const p = params as ItemStartedNotification;
    if (!p?.item?.type || !p.item.id) return;
    if (!TOOL_ITEM_TYPES.has(p.item.type)) return;
    // Duplicate item/started for the same id is a no-op — preserve
    // the first handle so the matching item/completed still drains
    // exactly one.
    if (!toolHandles.has(p.item.id)) {
      toolHandles.set(p.item.id, busy.start('tool_inflight'));
    }
  });

  rpc.onNotification(NOTIFICATIONS.itemCompleted, (params) => {
    const p = params as ItemCompletedNotification;
    if (!p?.item?.id) return;
    const handle = toolHandles.get(p.item.id);
    if (handle) {
      handle.finish();
      toolHandles.delete(p.item.id);
    }
  });

  rpc.onNotification(NOTIFICATIONS.turnCompleted, () => {
    drainAll('turn-completed');
  });

  return {
    drain(): void {
      drainAll('explicit-drain');
    },
    get inFlight() {
      return toolHandles.size;
    },
  };
}
