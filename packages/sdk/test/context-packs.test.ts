import { describe, expect, it } from 'vitest';
import {
  CONTEXT_PACKS,
  type ContextPack,
  composeInstructions,
  getContextPack,
} from '../src/context-packs.js';

/**
 * The registry is a contract three packages read (server composition, CLI
 * flags, web-ui checkboxes), so these tests pin the two things a consumer
 * cannot re-derive: the composition ORDER, and the promise that a shipped
 * pack's prose is portable across machines.
 */

/** Every pack body must read true on a laptop, a bare VM, or a container. */
const NON_PORTABLE_SUBSTRINGS = ['/workspace', '/scratch', 'station', 'qemu'];

function packById(id: string): ContextPack {
  const pack = getContextPack(id);
  if (pack === null) throw new Error(`expected pack ${id} to ship`);
  return pack;
}

describe('getContextPack', () => {
  it('resolves every id in the registry', () => {
    for (const pack of CONTEXT_PACKS) {
      expect(getContextPack(pack.id)).toBe(pack);
    }
  });

  it('returns null for an id this release does not ship', () => {
    expect(getContextPack('no-such-pack')).toBeNull();
    expect(getContextPack('')).toBeNull();
  });
});

describe('CONTEXT_PACKS', () => {
  it('ships the own-machine pack', () => {
    expect(CONTEXT_PACKS.map((p) => p.id)).toContain('own-machine');
  });

  it('gives every pack a non-empty id, title, summary, and body', () => {
    for (const pack of CONTEXT_PACKS) {
      expect(pack.id.trim(), `id of ${pack.id}`).not.toBe('');
      expect(pack.title.trim(), `title of ${pack.id}`).not.toBe('');
      expect(pack.summary.trim(), `summary of ${pack.id}`).not.toBe('');
      expect(pack.body.trim(), `body of ${pack.id}`).not.toBe('');
    }
  });

  it('keeps ids and titles unique', () => {
    const ids = CONTEXT_PACKS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    const titles = CONTEXT_PACKS.map((p) => p.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('keeps summaries unique and to a single line', () => {
    const summaries = CONTEXT_PACKS.map((p) => p.summary);
    expect(new Set(summaries).size).toBe(summaries.length);
    for (const pack of CONTEXT_PACKS) {
      expect(pack.summary, `summary of ${pack.id}`).not.toContain('\n');
    }
  });

  it('keeps bodies unique', () => {
    const bodies = CONTEXT_PACKS.map((p) => p.body);
    expect(new Set(bodies).size).toBe(bodies.length);
  });

  it('names no machine-specific path or provisioning mechanism in any body', () => {
    for (const pack of CONTEXT_PACKS) {
      const body = pack.body.toLowerCase();
      for (const banned of NON_PORTABLE_SUBSTRINGS) {
        expect(body, `body of ${pack.id} mentions ${banned}`).not.toContain(banned);
      }
    }
  });

  it('carries no headers or decoration a composer would have to strip', () => {
    for (const pack of CONTEXT_PACKS) {
      expect(pack.body, `body of ${pack.id}`).toBe(pack.body.trim());
      expect(pack.body, `body of ${pack.id}`).not.toMatch(/^\s*[#─-]/m);
    }
  });
});

describe('own-machine pack', () => {
  it('states the posture it exists to grant', () => {
    const body = packById('own-machine').body.toLowerCase();
    expect(body).toContain('yours');
    expect(body).toContain('install');
    expect(body).toContain('persist');
  });
});

describe('composeInstructions', () => {
  const own = packById('own-machine');

  it('returns empty for no packs and no instructions', () => {
    expect(composeInstructions([], '')).toBe('');
  });

  it('returns empty when instructions are only whitespace', () => {
    expect(composeInstructions([], '   \n\t ')).toBe('');
  });

  it('returns just the instructions when no packs are enabled', () => {
    expect(composeInstructions([], 'Ship the thing.')).toBe('Ship the thing.');
  });

  it('returns just the pack body when the member has no instructions', () => {
    expect(composeInstructions(['own-machine'], '')).toBe(own.body);
  });

  it('puts pack bodies before the member instructions', () => {
    const composed = composeInstructions(['own-machine'], 'Ship the thing.');
    expect(composed.indexOf(own.body)).toBe(0);
    expect(composed.endsWith('Ship the thing.')).toBe(true);
    expect(composed.indexOf(own.body)).toBeLessThan(composed.indexOf('Ship the thing.'));
  });

  it('separates blocks with a blank line and adds nothing else', () => {
    expect(composeInstructions(['own-machine'], 'Ship the thing.')).toBe(
      `${own.body}\n\nShip the thing.`,
    );
  });

  it('trims the member instructions before composing', () => {
    expect(composeInstructions([], '\n  Ship the thing.  \n')).toBe('Ship the thing.');
    expect(composeInstructions(['own-machine'], '\n\nShip the thing.\n\n')).toBe(
      `${own.body}\n\nShip the thing.`,
    );
  });

  it('skips unknown ids silently', () => {
    expect(composeInstructions(['no-such-pack'], 'Ship the thing.')).toBe('Ship the thing.');
    expect(composeInstructions(['no-such-pack'], '')).toBe('');
    expect(composeInstructions(['no-such-pack', 'own-machine', 'gone-in-v2'], 'Ship it.')).toBe(
      `${own.body}\n\nShip it.`,
    );
  });

  it('emits a duplicated id once', () => {
    expect(composeInstructions(['own-machine', 'own-machine'], '')).toBe(own.body);
  });

  it('keeps pack bodies in the order the caller listed them', () => {
    // Only exercisable once a second pack ships. Written against the real
    // registry rather than a fixture so the day it grows, this starts working.
    const [first, second] = CONTEXT_PACKS;
    if (first === undefined || second === undefined) return;
    expect(composeInstructions([first.id, second.id], '')).toBe(`${first.body}\n\n${second.body}`);
    expect(composeInstructions([second.id, first.id], '')).toBe(`${second.body}\n\n${first.body}`);
  });

  it('composes every shipped pack together with instructions last', () => {
    const ids = CONTEXT_PACKS.map((p) => p.id);
    const expected = [...CONTEXT_PACKS.map((p) => p.body), 'Ship the thing.'].join('\n\n');
    expect(composeInstructions(ids, 'Ship the thing.')).toBe(expected);
  });
});
