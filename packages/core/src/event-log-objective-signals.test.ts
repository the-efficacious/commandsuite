import type { Message } from 'csuite-sdk/types';
import { describe, expect, it } from 'vitest';
import { InMemoryEventLog } from './event-log.js';

function message(id: string, ts: number, body: string): Message {
  return {
    id,
    ts,
    from: 'rune',
    to: null,
    title: null,
    body,
    level: 'info',
    attachments: [],
    data: { kind: 'objective_discuss', thread: 'obj:obj-1' },
  };
}

describe('latestObjectiveSignals', () => {
  it('counts canonical pull URLs and never guesses from a bare issue/PR number', async () => {
    const log = new InMemoryEventLog();
    await log.append(message('1', 10, 'review #241'));
    await log.append(message('2', 20, 'https://github.com/the-efficacious/commandsuite/pull/241'));
    await log.append(message('3', 30, 'later thread post'));
    expect(await log.latestObjectiveSignals('obj-1')).toEqual({
      lastThreadPostAt: 30,
      lastPrLinkAt: 20,
    });
  });
});
