/**
 * Forwarder routing for broker-originated context controls.
 *
 * Two properties carry this file, and they pull in opposite
 * directions — which is why the suite needs both a positive and a
 * negative control:
 *
 *  1. A well-formed control reaches the HANDLER and does NOT reach the
 *     channel sink. Forwarding it as ambient text would put "compact
 *     your context" into the very context it is about to act on, where
 *     the agent could separately try to honour it and race the runner.
 *  2. A malformed control reaches NEITHER. It is dropped, because a
 *     control the runner cannot correlate would interrupt a member's
 *     work and leave the broker's request outstanding forever.
 *
 * A suite testing only (2) would pass against a forwarder that
 * discarded every control, including the good ones. A suite testing
 * only (1) would pass against one that executed garbage.
 */

import type { Client as BrokerClient } from 'csuite-sdk/client';
import type { Message } from 'csuite-sdk/types';
import { describe, expect, it } from 'vitest';
import type { ContextControlEvent } from '../../src/runtime/forwarder.js';
import { parseContextControl, runForwarder } from '../../src/runtime/forwarder.js';
import { recordingLogger } from '../helpers/logger.js';

function makeMessage(overrides: Partial<Message>): Message {
  return {
    id: 'msg-1',
    ts: 1_700_000_000_000,
    to: 'me',
    from: 'csuite',
    title: null,
    body: 'director asked your runner to compact your context.',
    level: 'notice',
    data: {},
    attachments: [],
    ...overrides,
  };
}

const wellFormed = {
  kind: 'context_control',
  requestId: 'req-1',
  verb: 'compact',
  target: 'me',
  requestedBy: 'director',
  reason: 'context is full',
};

/**
 * Drive the forwarder over a fixed message list, then abort. Unlike
 * the sibling suite's helper this does NOT stop on the first sink
 * delivery — a control that is correctly consumed produces no sink
 * event at all, so a delivery-triggered abort would deadlock exactly
 * the case under test.
 */
async function drive(messages: Message[]): Promise<{
  controls: ContextControlEvent[];
  sinkEvents: Array<{ content: string; meta: Record<string, string> }>;
  logs: string[];
}> {
  const controls: ContextControlEvent[] = [];
  const sinkEvents: Array<{ content: string; meta: Record<string, string> }> = [];
  const rec = recordingLogger();
  const ctrl = new AbortController();
  const client = {
    subscribe: (_name: string, signal: AbortSignal): AsyncIterable<Message> => ({
      [Symbol.asyncIterator]: async function* () {
        for (const m of messages) {
          if (signal.aborted) return;
          yield m;
        }
        // Every fixture has been through the loop body by now.
        queueMicrotask(() => ctrl.abort());
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    }),
    listChannels: async () => [],
  } as unknown as BrokerClient;

  await runForwarder({
    sink: {
      deliver: async (event) => {
        sinkEvents.push(event);
      },
    },
    brokerClient: client,
    name: 'me',
    signal: ctrl.signal,
    logger: rec.logger,
    onContextControlEvent: (control) => controls.push(control),
  });
  return { controls, sinkEvents, logs: rec.messages() };
}

describe('context control routing', () => {
  it('routes a well-formed control to the handler and keeps it OFF the channel sink', async () => {
    const { controls, sinkEvents } = await drive([makeMessage({ data: wellFormed })]);

    expect(controls).toEqual([
      {
        requestId: 'req-1',
        verb: 'compact',
        target: 'me',
        requestedBy: 'director',
        reason: 'context is full',
      },
    ]);
    // The positive half of the contract has a negative twin: consumed
    // means consumed, not "also delivered as chat".
    expect(sinkEvents).toEqual([]);
  });

  it('still delivers ordinary traffic to the sink — the consume is scoped to controls', async () => {
    const { controls, sinkEvents } = await drive([
      makeMessage({ id: 'm-chat', from: 'director', to: null, data: {}, body: 'morning' }),
      makeMessage({ id: 'm-ctl', data: wellFormed }),
    ]);

    // Positive control for the suppression above: a forwarder that
    // dropped everything would satisfy the previous test.
    expect(sinkEvents).toHaveLength(1);
    expect(sinkEvents[0]?.content).toBe('morning');
    expect(controls).toHaveLength(1);
  });

  it('IGNORES a control addressed to a teammate — we get a copy as the sender', async () => {
    // The defect this guards is not hypothetical. A recipient-list
    // push also goes to the sender, and leaves `to` null on every
    // copy — so without the target check, a director controlling a
    // worker would compact the DIRECTOR's own agent instead.
    const { controls, sinkEvents, logs } = await drive([
      makeMessage({ data: { ...wellFormed, target: 'worker', requestedBy: 'me' } }),
    ]);

    expect(controls).toEqual([]);
    expect(sinkEvents).toEqual([]);
    expect(logs).toContain('ignored context control addressed to another member');
  });

  it('drops a malformed control without executing OR forwarding it', async () => {
    const { controls, sinkEvents, logs } = await drive([
      // No requestId: executable but never correlatable, so running it
      // would interrupt the member and leave the request outstanding.
      makeMessage({ id: 'm-1', data: { ...wellFormed, requestId: undefined } }),
      // Unknown verb.
      makeMessage({ id: 'm-2', data: { ...wellFormed, verb: 'shutdown' } }),
    ]);

    expect(controls).toEqual([]);
    expect(sinkEvents).toEqual([]);
    expect(logs.filter((m) => m === 'dropped malformed context control')).toHaveLength(2);
  });

  it('logs rather than silently swallowing when no handler is registered', async () => {
    // Same drive, minus the handler — a runner that cannot act must
    // leave the request visibly unanswered, not pretend.
    const ctrl = new AbortController();
    const rec = recordingLogger();
    const client = {
      subscribe: (_n: string, signal: AbortSignal): AsyncIterable<Message> => ({
        [Symbol.asyncIterator]: async function* () {
          yield makeMessage({ data: wellFormed });
          queueMicrotask(() => ctrl.abort());
          await new Promise<void>((resolve) => {
            if (signal.aborted) return resolve();
            signal.addEventListener('abort', () => resolve(), { once: true });
          });
        },
      }),
      listChannels: async () => [],
    } as unknown as BrokerClient;

    const sinkEvents: unknown[] = [];
    await runForwarder({
      sink: { deliver: async (e) => void sinkEvents.push(e) },
      brokerClient: client,
      name: 'me',
      signal: ctrl.signal,
      logger: rec.logger,
    });

    expect(sinkEvents).toEqual([]);
    expect(rec.messages()).toContain('context control received but this runner has no handler');
  });
});

describe('parseContextControl', () => {
  it('accepts the broker payload and normalises an absent reason to omitted', () => {
    const { reason, ...required } = wellFormed;
    expect(parseContextControl(required)).toEqual({
      requestId: 'req-1',
      verb: 'compact',
      target: 'me',
      requestedBy: 'director',
    });
    // Not `reason: undefined` — an explicit undefined key would ride
    // into the ack's optional-field spread as a present key.
    expect(parseContextControl(required)).not.toHaveProperty('reason');
  });

  it('accepts `clear` — the nearest valid thing to the rejected verbs', () => {
    // Positive control: a parser that returned null for everything
    // would satisfy every rejection case below.
    expect(parseContextControl({ ...wellFormed, verb: 'clear' })?.verb).toBe('clear');
  });

  it('rejects payloads missing any field the acknowledgement depends on', () => {
    const cases: Array<[string, unknown]> = [
      ['not an object', 'context_control'],
      ['null', null],
      ['wrong kind', { ...wellFormed, kind: 'instructions' }],
      ['missing requestId', { ...wellFormed, requestId: undefined }],
      ['empty requestId', { ...wellFormed, requestId: '' }],
      ['non-string requestId', { ...wellFormed, requestId: 7 }],
      ['unknown verb', { ...wellFormed, verb: 'shutdown' }],
      ['missing target', { ...wellFormed, target: undefined }],
      ['empty target', { ...wellFormed, target: '' }],
      ['missing requestedBy', { ...wellFormed, requestedBy: undefined }],
      ['empty requestedBy', { ...wellFormed, requestedBy: '' }],
    ];
    for (const [label, input] of cases) {
      expect(parseContextControl(input), label).toBeNull();
    }
  });
});
