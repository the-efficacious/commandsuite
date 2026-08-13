/**
 * Codex compaction — request, and the ack that proves it happened.
 *
 * `thread/compact/start` asks codex to summarise the thread and
 * continue from the summary. **Its response is an empty object.** It
 * acknowledges that the request was accepted, and says nothing at all
 * about whether a compaction occurred — so a caller that resolved on
 * the response would be reporting a success it never observed, which
 * is exactly the failure shape the broker's context-control
 * acknowledgement exists to prevent.
 *
 * The evidence is asynchronous: codex emits an `item/completed`
 * carrying a `contextCompaction` item once the summarisation lands.
 * This module correlates the two, so `request()` resolves on the
 * EFFECT rather than on the ask.
 *
 * (There is also a `context/compacted` notification. The 0.145.0
 * app-server schema marks it deprecated in favour of the item type, so
 * the item is what we listen for.)
 *
 * Extracted rather than inlined in `adapter.ts` for the same reason
 * `busy-sniff.ts` is: the correlation is the part with a race in it,
 * and it should be exercisable against a mock JSON-RPC client without
 * standing up a codex child process.
 */

import type { AgentLog } from '../adapter.js';
import type { JsonRpcClient } from './json-rpc.js';
import { ITEM_TYPES, type ItemCompletedNotification, METHODS, NOTIFICATIONS } from './protocol.js';

/**
 * What a codex compaction produced.
 *
 * No token accounting: the `contextCompaction` item carries `{ id,
 * type }` only. Unlike the claude path there is no before/after to
 * report, and an invented zero would read as "compacted to nothing".
 */
export type CodexCompactOutcome = { applied: true } | { applied: false; detail: string };

/**
 * How long to wait for the `contextCompaction` item after codex has
 * accepted the request. Generous, because summarising a long thread is
 * genuinely slow — but bounded, because a codex that died mid-compaction
 * must not leave the broker's request outstanding forever.
 */
export const COMPACT_TIMEOUT_MS = 180_000;

export interface CodexCompactor {
  /**
   * Ask codex to compact, resolving with what it reported. Never
   * throws — a transport failure is an outcome, not an exception,
   * because every path has to produce an acknowledgement.
   */
  request(timeoutMs?: number): Promise<CodexCompactOutcome>;
  /** Stop listening. Idempotent. */
  close(): void;
}

export function attachCodexCompactor(opts: {
  rpc: JsonRpcClient;
  getThreadId: () => string | null;
  log: AgentLog;
  /**
   * Fired on EVERY observed `contextCompaction` item — requested or
   * codex's own auto-compaction. Either way the conversation just
   * shrank to a summary, which is exactly when the open-objectives
   * plate needs re-asserting; the runner's re-brief cooldown absorbs
   * the requested case double-firing with the broker's own ack path.
   */
  onCompacted?: () => void;
  /** Test seam. Defaults to setTimeout/clearTimeout. */
  timers?: {
    set: (fn: () => void, ms: number) => unknown;
    clear: (handle: unknown) => void;
  };
}): CodexCompactor {
  const timers = opts.timers ?? {
    set: (fn, ms) => {
      const t = setTimeout(fn, ms);
      (t as { unref?: () => void }).unref?.();
      return t;
    },
    clear: (h) => clearTimeout(h as NodeJS.Timeout),
  };

  let pending: ((outcome: CodexCompactOutcome) => void) | null = null;

  // Subscribed for the life of the session rather than per request.
  // Registering on demand would race: codex can emit the completion
  // between the request resolving and a late subscription landing.
  const unsubscribe = opts.rpc.onNotification(NOTIFICATIONS.itemCompleted, (params) => {
    const p = params as ItemCompletedNotification;
    if (p?.item?.type !== ITEM_TYPES.contextCompaction) return;
    // Every compaction is reported outward, attributed or not — the
    // context shrank either way, and the observer (the runner's
    // re-brief) cares about the effect, not who asked for it.
    try {
      opts.onCompacted?.();
    } catch (err) {
      opts.log('codex: onCompacted observer threw', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (pending === null) {
      // A compaction codex decided on by itself (auto-compaction), or
      // one whose request already timed out. Noted, not attributed —
      // acking an unrequested compaction against a stale request id
      // would close out the wrong thing.
      opts.log('codex: observed a compaction we did not request');
      return;
    }
    const settle = pending;
    pending = null;
    settle({ applied: true });
  });

  return {
    async request(timeoutMs = COMPACT_TIMEOUT_MS): Promise<CodexCompactOutcome> {
      const threadId = opts.getThreadId();
      if (threadId === null) {
        return { applied: false, detail: 'no codex thread is open yet' };
      }
      if (pending !== null) {
        return { applied: false, detail: 'a compaction request is already in flight' };
      }
      const settled = new Promise<CodexCompactOutcome>((resolve) => {
        const timer = timers.set(() => {
          pending = null;
          resolve({
            applied: false,
            detail: `codex did not report a contextCompaction item within ${Math.round(timeoutMs / 1000)}s`,
          });
        }, timeoutMs);
        pending = (outcome) => {
          timers.clear(timer);
          resolve(outcome);
        };
      });
      try {
        await opts.rpc.request(METHODS.threadCompactStart, { threadId });
      } catch (err) {
        pending = null;
        return {
          applied: false,
          detail: `codex refused the compaction request: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      return settled;
    },
    close(): void {
      unsubscribe();
      const settle = pending;
      pending = null;
      settle?.({ applied: false, detail: 'the codex session ended before compaction completed' });
    },
  };
}
