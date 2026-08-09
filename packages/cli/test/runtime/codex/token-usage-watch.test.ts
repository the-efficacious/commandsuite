/**
 * The codex dump-signal spike.
 *
 * This is measurement, not correctness — nothing in the spine depends
 * on it firing — so what is asserted is narrow and exact: the series
 * shapes it must and must not call a discontinuity, the LINE it
 * produces (named as a string, then grepped for, because an operator
 * reading stderr is the entire consumer), and the fact that reporting
 * stays behind the env flag.
 *
 * The classifier is tested directly rather than only through the
 * subscription, because the series shapes are the part nobody can
 * check by reading. The subscription is tested too — a classifier
 * proven correct behind a handler that never subscribed is the
 * "helper proven, deliverable absent" failure the house standard is
 * explicit about.
 */

import { describe, expect, it, vi } from 'vitest';
import type { JsonRpcClient } from '../../../src/runtime/agents/codex/json-rpc.js';
import { NOTIFICATIONS } from '../../../src/runtime/agents/codex/protocol.js';
import {
  attachCodexTokenUsageWatch,
  CODEX_DUMP_LOG_LINE,
  CODEX_DUMP_SIGNAL_ENV,
  classifyTokenUsage,
} from '../../../src/runtime/agents/codex/token-usage-watch.js';

interface FakeRpc extends JsonRpcClient {
  emit(method: string, params: unknown): void;
  subscribed(): string[];
}

function makeFakeRpc(): FakeRpc {
  const handlers = new Map<string, Array<(p: unknown) => void>>();
  return {
    request: vi.fn().mockResolvedValue({}),
    notify: vi.fn(),
    onNotification(method: string, handler: (p: unknown) => void): () => void {
      const list = handlers.get(method) ?? [];
      list.push(handler);
      handlers.set(method, list);
      return () => {};
    },
    onRequest: vi.fn(() => () => {}),
    closed: Promise.resolve(),
    close: vi.fn(),
    emit(method: string, params: unknown): void {
      for (const h of handlers.get(method) ?? []) h(params);
    },
    subscribed(): string[] {
      return [...handlers.keys()];
    },
  };
}

function usage(total: number | null, last: number | null, window: number | null): unknown {
  return {
    threadId: 'thr_1',
    turnId: 'turn_1',
    tokenUsage: {
      ...(total === null ? {} : { total: { totalTokens: total } }),
      ...(last === null ? {} : { last: { totalTokens: last } }),
      ...(window === null ? {} : { modelContextWindow: window }),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────

describe('classifying a token series', () => {
  it('calls a DROP in the running total a reset', () => {
    expect(
      classifyTokenUsage(
        { total: 120_000, last: 9_000, window: 200_000 },
        {
          total: 4_000,
          last: 4_000,
          window: 200_000,
        },
      ),
    ).toBe('total_reset');
  });

  it('calls a COLLAPSING `last` its own shape, while the total keeps climbing', () => {
    // The shape a real compaction should leave, and the reason it is
    // measured at all: `total` reads like a cumulative BILLING counter
    // for the thread, so a reset there is a thread restart rather than
    // a compaction. If that is right, this is the signal to trust —
    // the next request carries a summarised prefix instead of the full
    // history while the bill keeps growing.
    expect(
      classifyTokenUsage(
        { total: 100_000, last: 90_000, window: 200_000 },
        { total: 112_000, last: 9_000, window: 200_000 },
      ),
    ).toBe('last_shrank');
  });

  it('does not call an ordinary short turn a collapse', () => {
    // Turns vary enormously. A small drop is the normal texture of a
    // session, and a watcher that called every one of them a dump
    // would report one on nearly every turn.
    expect(
      classifyTokenUsage(
        { total: 100_000, last: 90_000, window: 200_000 },
        { total: 150_000, last: 60_000, window: 200_000 },
      ),
    ).toBeNull();
  });

  it('calls a saturated window what it is, and not a reset', () => {
    // Nothing has been discarded yet. Distinguishing the two matters:
    // one is evidence the context is already gone, the other is the
    // state it goes from, and an operator reading "reset" would draw
    // the wrong conclusion about when.
    expect(
      classifyTokenUsage(
        { total: 100_000, last: 90_000, window: 200_000 },
        {
          total: 300_000,
          last: 200_000,
          window: 200_000,
        },
      ),
    ).toBe('window_saturated');
  });

  it('says nothing about the first observation of a session', () => {
    // A series of one has no shape. Reporting a discontinuity here
    // would fire on every cold start, which is precisely when a
    // member's context is newest.
    expect(classifyTokenUsage(null, { total: 4_000, last: 4_000, window: 200_000 })).toBeNull();
  });

  it('leaves a normal, growing series alone', () => {
    // The positive control on the whole classifier: an ordinary
    // session must produce nothing, or every run would report a dump.
    let previous: { total: number; last: number; window: number } | null = null;
    const calls: (string | null)[] = [];
    for (const total of [4_000, 11_000, 26_000, 51_000, 88_000]) {
      const next = { total, last: 9_000, window: 200_000 };
      calls.push(classifyTokenUsage(previous, next));
      previous = next;
    }
    expect(calls).toEqual([null, null, null, null, null]);
  });

  it('does not call an unchanged total a reset', () => {
    // A repeated notification, or a turn that consumed nothing. An
    // idle thread must not look like one losing its memory.
    expect(
      classifyTokenUsage(
        { total: 50_000, last: 1_000, window: 200_000 },
        {
          total: 50_000,
          last: 1_000,
          window: 200_000,
        },
      ),
    ).toBeNull();
  });

  it('needs both operands before it will compare them', () => {
    // Older codex builds drop fields. A missing window must read as
    // "cannot tell", never as a saturated one.
    expect(
      classifyTokenUsage(
        { total: 10_000, last: 5_000, window: null },
        {
          total: 20_000,
          last: 999_999,
          window: null,
        },
      ),
    ).toBeNull();
    expect(
      classifyTokenUsage(
        { total: null, last: null, window: 200_000 },
        {
          total: null,
          last: null,
          window: 200_000,
        },
      ),
    ).toBeNull();
  });
});

describe('the subscription codex has been emitting into nothing', () => {
  it('subscribes to thread/tokenUsage/updated', () => {
    const rpc = makeFakeRpc();
    attachCodexTokenUsageWatch({ rpc, log: () => {}, env: {} });
    // The adapter never subscribed to this before. A classifier proven
    // correct behind a handler nobody registered is the exact shape of
    // a helper with no caller.
    expect(rpc.subscribed()).toContain(NOTIFICATIONS.tokenUsageUpdated);
    expect(NOTIFICATIONS.tokenUsageUpdated).toBe('thread/tokenUsage/updated');
  });

  it('produces the operator line, with both operands, on a reset', () => {
    const rpc = makeFakeRpc();
    const lines: Array<{ msg: string; ctx?: Record<string, unknown> }> = [];
    const watch = attachCodexTokenUsageWatch({
      rpc,
      log: (msg, ctx) => lines.push({ msg, ...(ctx ? { ctx } : {}) }),
      env: {},
    });

    rpc.emit(NOTIFICATIONS.tokenUsageUpdated, usage(120_000, 9_000, 200_000));
    expect(lines, 'the first observation must be silent').toHaveLength(0);
    rpc.emit(NOTIFICATIONS.tokenUsageUpdated, usage(4_000, 4_000, 200_000));

    expect(lines).toHaveLength(1);
    expect(lines[0]?.msg).toBe(CODEX_DUMP_LOG_LINE);
    expect(lines[0]?.ctx).toMatchObject({
      discontinuity: 'total_reset',
      total: 4_000,
      modelContextWindow: 200_000,
      threadId: 'thr_1',
      reported: false,
    });
    expect(watch.detected()).toEqual(['total_reset']);
    expect(watch.seen()).toBe(2);
  });

  it('does NOT report to the curator with the flag unset', () => {
    const rpc = makeFakeRpc();
    const reported: string[] = [];
    attachCodexTokenUsageWatch({
      rpc,
      log: () => {},
      reportDump: (source) => reported.push(source),
      env: {},
    });
    rpc.emit(NOTIFICATIONS.tokenUsageUpdated, usage(120_000, 9_000, 200_000));
    rpc.emit(NOTIFICATIONS.tokenUsageUpdated, usage(4_000, 4_000, 200_000));
    expect(reported).toEqual([]);
  });

  it('reports `token_discontinuity` when the operator sets the flag', () => {
    // The positive control on the gate: a flag that gated everything
    // to nothing would satisfy the test above just as happily.
    const rpc = makeFakeRpc();
    const reported: string[] = [];
    attachCodexTokenUsageWatch({
      rpc,
      log: () => {},
      reportDump: (source) => reported.push(source),
      env: { [CODEX_DUMP_SIGNAL_ENV]: '1' },
    });
    rpc.emit(NOTIFICATIONS.tokenUsageUpdated, usage(120_000, 9_000, 200_000));
    rpc.emit(NOTIFICATIONS.tokenUsageUpdated, usage(4_000, 4_000, 200_000));
    expect(reported).toEqual(['token_discontinuity']);
  });

  it('treats any value other than `1` as off', () => {
    const rpc = makeFakeRpc();
    const reported: string[] = [];
    attachCodexTokenUsageWatch({
      rpc,
      log: () => {},
      reportDump: (source) => reported.push(source),
      env: { [CODEX_DUMP_SIGNAL_ENV]: 'true' },
    });
    rpc.emit(NOTIFICATIONS.tokenUsageUpdated, usage(120_000, 9_000, 200_000));
    rpc.emit(NOTIFICATIONS.tokenUsageUpdated, usage(4_000, 4_000, 200_000));
    expect(reported).toEqual([]);
  });

  it('is EDGE-triggered: a window that stays saturated logs once', () => {
    // A saturated window is still saturated on the next notification,
    // and the next. A level-triggered watcher logs the same line ten
    // times through one long turn, and a stream of identical lines is
    // how an operator learns to stop reading a channel.
    const rpc = makeFakeRpc();
    const lines: string[] = [];
    attachCodexTokenUsageWatch({ rpc, log: (msg) => lines.push(msg), env: {} });
    for (let i = 0; i < 4; i++) {
      rpc.emit(NOTIFICATIONS.tokenUsageUpdated, usage(100_000 + i * 1_000, 200_000, 200_000));
    }
    expect(lines).toHaveLength(1);

    // The positive control on the edge: when the condition clears and
    // returns, it logs again — otherwise "log once" would be
    // indistinguishable from "log once, ever".
    // An ordinary large-but-not-full turn clears the condition (not a
    // collapse either — it is well inside the ratio), then the window
    // fills again.
    rpc.emit(NOTIFICATIONS.tokenUsageUpdated, usage(210_000, 120_000, 200_000));
    expect(lines, 'the clearing observation is not itself an event').toHaveLength(1);
    rpc.emit(NOTIFICATIONS.tokenUsageUpdated, usage(220_000, 200_000, 200_000));
    expect(lines).toHaveLength(2);
  });

  it('LOGS a saturated window but never reports it, even with the flag on', () => {
    // By this spike's own account nothing has been discarded yet when
    // the window fills — it is the state a discard happens FROM.
    // Reporting it as `dump_declared` would be reporting a forecast as
    // an event, and the curator would invalidate a lease for a context
    // that is still entirely intact.
    const rpc = makeFakeRpc();
    const lines: Array<Record<string, unknown> | undefined> = [];
    const reported: string[] = [];
    attachCodexTokenUsageWatch({
      rpc,
      log: (_msg, ctx) => lines.push(ctx),
      reportDump: (source) => reported.push(source),
      env: { [CODEX_DUMP_SIGNAL_ENV]: '1' },
    });
    rpc.emit(NOTIFICATIONS.tokenUsageUpdated, usage(100_000, 200_000, 200_000));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ discontinuity: 'window_saturated', reported: false });
    expect(reported, 'a forecast is not an event').toEqual([]);

    // The positive control, same watcher, same flag: a total reset IS
    // reported. Without it this passes against a spike that reports
    // nothing at all.
    rpc.emit(NOTIFICATIONS.tokenUsageUpdated, usage(4_000, 4_000, 200_000));
    expect(reported).toEqual(['token_discontinuity']);
  });

  it('logs but never reports a collapsing `last`, flag or no flag', () => {
    const rpc = makeFakeRpc();
    const lines: Array<Record<string, unknown> | undefined> = [];
    const reported: string[] = [];
    attachCodexTokenUsageWatch({
      rpc,
      log: (_msg, ctx) => lines.push(ctx),
      reportDump: (source) => reported.push(source),
      env: { [CODEX_DUMP_SIGNAL_ENV]: '1' },
    });
    rpc.emit(NOTIFICATIONS.tokenUsageUpdated, usage(100_000, 90_000, 200_000));
    rpc.emit(NOTIFICATIONS.tokenUsageUpdated, usage(112_000, 9_000, 200_000));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ discontinuity: 'last_shrank', reported: false });
    expect(reported, 'the shape being measured is not yet the shape being trusted').toEqual([]);
  });

  it('survives a payload with no tokenUsage at all', () => {
    const rpc = makeFakeRpc();
    const lines: string[] = [];
    const watch = attachCodexTokenUsageWatch({
      rpc,
      log: (msg) => lines.push(msg),
      env: {},
    });
    rpc.emit(NOTIFICATIONS.tokenUsageUpdated, { threadId: 'thr_1' });
    rpc.emit(NOTIFICATIONS.tokenUsageUpdated, {});
    expect(lines).toEqual([]);
    expect(watch.seen()).toBe(2);
  });
});
