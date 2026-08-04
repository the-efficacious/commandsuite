import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { HUD_HEIGHT, startHud } from '../../src/runtime/hud.js';
import { createPresence, type PresenceState } from '../../src/runtime/presence.js';

/**
 * The HUD writes its whole strip as escape-interleaved text, so the
 * only thing a test can honestly measure is what a terminal would
 * *print*. These helpers reduce a write to that: drop the escape
 * sequences, then pull the row the status strip was positioned to.
 */
const ESC = '\x1b';
// Built from a string rather than written as a literal: a raw control
// character inside a regex literal is a lint error (and unreadable).
const ANSI = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]|${ESC}[78]`, 'g');

function stripAnsi(s: string): string {
  return s.replace(ANSI, '');
}

/**
 * Extract the printable run that follows the cursor-position + erase
 * pair targeting `row`, up to whatever moves the cursor next. That is
 * exactly the glyph sequence the terminal lays down starting at column
 * 1 of that row, so its length is the number of columns consumed.
 *
 * The upper cut matters: without it a row's text runs on into the next
 * row's and every width reads long.
 */
const CURSOR_MOVE = new RegExp(`${ESC}\\[\\d+;\\d+H|${ESC}8`);

function rowText(out: string, row: number): string {
  const marker = `${ESC}[${row};1H${ESC}[2K`;
  const at = out.indexOf(marker);
  expect(at, `no write positioned to row ${row}`).toBeGreaterThanOrEqual(0);
  const rest = out.slice(at + marker.length);
  const next = rest.search(CURSOR_MOVE);
  return stripAnsi(next === -1 ? rest : rest.slice(0, next));
}

interface Rendered {
  status: string;
  separator: string;
}

function render(opts: {
  cols: number;
  rows?: number;
  label?: string;
  state?: PresenceState;
}): Rendered {
  const rows = opts.rows ?? 24;
  const chunks: string[] = [];
  const stdout = Object.assign(new EventEmitter(), {
    isTTY: true,
    write: (s: string) => {
      chunks.push(s);
      return true;
    },
  }) as unknown as NodeJS.WriteStream;

  const hud = startHud({
    presence: createPresence(opts.state ?? 'online'),
    label: opts.label,
    stdout,
    getSize: () => ({ rows, cols: opts.cols }),
  });
  hud.redraw();
  hud.close();

  const out = chunks.join('');
  return { status: rowText(out, rows), separator: rowText(out, rows - 1) };
}

const STATES: PresenceState[] = ['connecting', 'online', 'offline'];

describe('hud status strip', () => {
  it('renders the full label, flush right, at a comfortable width', () => {
    // The positive control. A strip that simply dropped or truncated
    // the label would satisfy every width bound below.
    const { status } = render({ cols: 80, label: 'csuite claude · atlas' });

    expect(status).toContain('csuite claude · atlas');
    expect(status).not.toContain('…');
    expect(status).toContain('csuite · ● Online');
    // Flush right: the label ends one pad column short of the edge.
    expect(status).toMatch(/atlas $/);
    expect(status).toHaveLength(80);
  });

  it('occupies exactly the terminal width, for any width, state, or label', () => {
    // The regression, and its mirror. The strip used to run exactly 2
    // columns long at every width; because the status row sits below
    // the DECSTBM region, that tail wrapped onto column 1 of the same
    // row and the end of the agent name appeared in the bottom-left
    // corner. Asserting equality rather than `<= cols` also rules out
    // the opposite fix — one that stops overflowing by rendering a
    // stunted strip that no longer reaches the right edge.
    for (const state of STATES) {
      for (const label of ['csuite codex · a', 'csuite claude · a-longish-agent-name']) {
        for (let cols = 10; cols <= 200; cols++) {
          const { status, separator } = render({ cols, label, state });
          const where = `cols=${cols} state=${state} label=${label}`;
          expect(status.length, `status width at ${where}`).toBe(cols);
          expect(separator.length, `separator width at ${where}`).toBe(cols);
        }
      }
    }
  });

  it('shows the whole label from the first width that can hold it', () => {
    // Pins the fit boundary from both sides, stated independently of
    // the implementation's arithmetic: PAD_LEFT(2) + 'csuite · ● Online'
    // (17) + MIN_GAP(1) + label + PAD_RIGHT(1).
    const label = 'csuite codex · atlas';
    const minFit = 2 + 17 + 1 + label.length + 1;

    const fits = render({ cols: minFit, label }).status;
    expect(fits).toContain(label);
    expect(fits).toBe(`  csuite · ● Online ${label} `);

    expect(render({ cols: minFit - 1, label }).status).not.toContain(label);
  });

  it('holds the label against the right edge as the terminal widens', () => {
    for (let cols = 41; cols <= 200; cols++) {
      const { status } = render({ cols, label: 'csuite codex · atlas' });
      expect(status, `strip not flush at cols=${cols}`).toMatch(/atlas $/);
    }
  });

  it('ellipsizes the label on a narrow terminal instead of wrapping it', () => {
    const { status } = render({ cols: 40, label: 'csuite claude · a-very-long-agent-name' });

    expect(status.length).toBeLessThanOrEqual(40);
    expect(status).toContain('csuite · ● Online');
    expect(status).toContain('…');
    // Still a real prefix of the label, not a bare marker.
    expect(status).toContain('csuite cl');
  });

  it('holds the bound when even the state chunk cannot fit', () => {
    const { status } = render({ cols: 12, label: 'csuite claude · atlas' });

    expect(status.length).toBeLessThanOrEqual(12);
    expect(status).toContain('csuite');
  });

  it('reserves HUD_HEIGHT rows and leaves the agent viewport above them', () => {
    const rows = 24;
    const chunks: string[] = [];
    const stdout = Object.assign(new EventEmitter(), {
      isTTY: true,
      write: (s: string) => {
        chunks.push(s);
        return true;
      },
    }) as unknown as NodeJS.WriteStream;

    const hud = startHud({
      presence: createPresence('online'),
      stdout,
      getSize: () => ({ rows, cols: 80 }),
    });
    hud.redraw();
    const out = chunks.join('');
    hud.close();

    expect(out).toContain(`${ESC}[1;${rows - HUD_HEIGHT}r`);
  });
});
