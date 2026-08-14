/**
 * Bottom-of-terminal status strip for `csuite claude` sessions.
 *
 * Claude's ink-rendered TUI paints into the top `rows - PANEL_HEIGHT`
 * rows of the terminal because that's what the pty reports via
 * TIOCGWINSZ (see `runtime/agents/claude-agent.ts`). The HUD owns the
 * remaining rows at the bottom: a thin separator line and a one-line
 * status strip. For v1 that strip shows just a presence dot
 * (online/offline/connecting) and the session name.
 *
 * Rendering approach:
 *
 *   1. Drawing: save cursor (DECSC), set absolute position to the
 *      HUD row, write our strip with truecolor SGR, restore cursor
 *      (DECRC). Claude never sees the escape sequences — they're
 *      injected directly into the real stdout after we've forwarded
 *      claude's own output.
 *
 *   2. Redraw triggers: (a) presence state change, (b) SIGWINCH, and
 *      (c) every time we forward a chunk of claude output. (c) is
 *      the important one — claude commonly emits `CSI 2J` on alt-
 *      screen entry + repaints, which wipes rows outside its
 *      reported viewport (i.e. our panel). Cheap to re-emit one
 *      line after every write.
 *
 *   3. Cleanup on close: clear the panel rows, move cursor to
 *      bottom of real screen, reset color. Runs on shutdown so the
 *      terminal returns to a clean state.
 *
 * The HUD is a no-op when stdout isn't a TTY — tests and redirected
 * output see exactly the behavior they did before we added it.
 */

import { helm } from '@the-efficacious/brand';
import type { Logger } from 'csuite-core';
import type { Presence, PresenceState } from './presence.js';

/** Number of rows reserved for the HUD (separator + status). */
export const HUD_HEIGHT = 2;

const ESC = '\x1b';
const CSI = `${ESC}[`;

const SAVE_CURSOR = `${ESC}7`;
const RESTORE_CURSOR = `${ESC}8`;
const RESET_SGR = `${CSI}0m`;
const DIM = `${CSI}2m`;
const BOLD = `${CSI}1m`;

/** Foreground color via truecolor SGR, from a '#rrggbb' brand value. */
function fg(hex: string | undefined): string {
  if (!hex) throw new Error('missing brand role — check the @the-efficacious/brand version');
  const n = Number.parseInt(hex.slice(1), 16);
  return `${CSI}38;2;${(n >> 16) & 0xff};${(n >> 8) & 0xff};${n & 0xff}m`;
}

/** Move cursor to (row, col), both 1-indexed. */
function cup(row: number, col: number): string {
  return `${CSI}${row};${col}H`;
}

/** Erase the line the cursor is currently on. */
const EL = `${CSI}2K`;

/**
 * Set top/bottom scroll margins (DECSTBM). With margins set to
 * `1;(rows - HUD_HEIGHT)`, claude's content scrolls only within its
 * reported viewport — our HUD rows stay pinned to the real bottom.
 * Without this, a `\n` at claude's last row would scroll our panel
 * up with the rest of the output and leave stale separators behind.
 */
function decstbm(top: number, bottom: number): string {
  return `${CSI}${top};${bottom}r`;
}
/** Reset the scroll region to full screen. */
const DECSTBM_RESET = `${CSI}r`;

// Palette — Helm roles from @the-efficacious/brand (tsup inlines the
// values at build time), so the terminal HUD reads as a sibling of the
// web UI chrome. Connection state uses the lamp grammar: nominal when
// the link is up, working while it's being raised, alarm when it's
// down — the HUD's whole job is that link, so losing it is a fault,
// not a stand-down. The "csuite" word carries the gold mark — the
// strip's single assertion.
const ONLINE = fg(helm.color.lampNominal);
const OFFLINE = fg(helm.color.lampAlarm);
const CONNECTING = fg(helm.color.lampWorking);
const BRAND = fg(helm.color.mark);
const AGENT_NAME = fg(helm.color.textSecondary);
const SEPARATOR = fg(helm.color.textMuted);

/** Blank columns held at each end of the status strip. */
const PAD_LEFT = 2;
const PAD_RIGHT = 1;
/** Smallest blank run kept between the state chunk and the label. */
const MIN_GAP = 1;

/**
 * A run of text and the SGR prefix it's painted with. Keeping the two
 * apart is the point: widths are measured on `text` alone, so escape
 * bytes can never be mistaken for columns.
 *
 * Widths count UTF-16 units, which is the display width for the ASCII
 * and single-width box glyphs this strip is built from.
 */
type Piece = [sgr: string, text: string];

const width = (pieces: Piece[]): number => pieces.reduce((n, [, text]) => n + text.length, 0);

/**
 * Trim `text` to at most `max` columns, marking the cut with an
 * ellipsis so a clipped agent name reads as clipped. Returns '' when
 * there's no room for a name plus its marker.
 */
function ellipsize(text: string, max: number): string {
  if (max >= text.length) return text;
  if (max < 2) return '';
  return `${text.slice(0, max - 1)}…`;
}

/**
 * Concatenate pieces, stopping at `max` visible columns.
 *
 * This clip is the strip's backstop, not its layout: `render` already
 * sizes the gap so everything fits. It exists because overflowing by
 * even one column is not a cosmetic error here — see the wrap note in
 * `render`.
 */
function paint(pieces: Piece[], max: number): string {
  let out = '';
  let used = 0;
  for (const [sgr, text] of pieces) {
    if (used >= max) break;
    const shown = text.slice(0, max - used);
    used += shown.length;
    out += sgr ? `${sgr}${shown}${RESET_SGR}` : shown;
  }
  return out;
}

export interface StartHudOptions {
  presence: Presence;
  /** Display label rendered on the right side of the strip. */
  label?: string;
  /** Override process.stdout for tests. */
  stdout?: NodeJS.WriteStream;
  /**
   * Callback invoked whenever the HUD needs the current terminal
   * size. Defaults to reading `process.stdout.rows` /
   * `process.stdout.columns`. Tests can inject a fixed size.
   */
  getSize?: () => { rows: number; cols: number };
  /**
   * Scroll existing terminal content up by `HUD_HEIGHT` rows and home
   * the cursor to the bottom of what will become the scroll region,
   * before the first render runs.
   *
   * Required when the caller's prior output has left the cursor at
   * (or near) the bottom of the main screen buffer — `csuite codex`,
   * which prints stderr banners before starting the HUD, hits this.
   * Without reservation, DECSTBM sets a scroll region above the cursor,
   * subsequent writes land on the HUD rows (cursor is *outside* the
   * region, so `\n` doesn't scroll), and the next repaint clobbers
   * them.
   *
   * Not needed for `csuite claude`: claude's first output enters the
   * alternate screen buffer (ESC[?1049h), giving us a fresh canvas
   * with the cursor already at row 1 — comfortably inside the region.
   * Default false to keep that path byte-for-byte unchanged.
   */
  reserveBottomSpace?: boolean;
  logger?: Logger;
}

export interface HudHandle {
  /** Repaint the HUD. Idempotent and cheap — safe to call often. */
  redraw(): void;
  /**
   * Tear down the HUD: clear its rows, reset cursor, unsubscribe
   * from presence updates. Idempotent.
   */
  close(): void;
}

export function startHud(options: StartHudOptions): HudHandle {
  const stdout = options.stdout ?? process.stdout;
  const presence = options.presence;
  const label = options.label ?? 'csuite claude';
  const getSize =
    options.getSize ??
    ((): { rows: number; cols: number } => ({
      rows: stdout.rows ?? 24,
      cols: stdout.columns ?? 80,
    }));

  if (!stdout.isTTY) {
    return { redraw: () => {}, close: () => {} };
  }

  // Reserve the bottom HUD_HEIGHT rows before any render runs (and
  // before the first DECSTBM in render() takes effect). Newlines
  // scroll existing content up; the CUP lands the cursor at the
  // bottom of the soon-to-be scroll region so subsequent writes
  // sit *inside* it. See the option's doc-comment for the full why.
  if (options.reserveBottomSpace) {
    const { rows } = getSize();
    if (rows >= HUD_HEIGHT + 1) {
      stdout.write('\n'.repeat(HUD_HEIGHT) + cup(rows - HUD_HEIGHT, 1));
    }
  }

  let closed = false;
  let everRendered = false;
  let currentState: PresenceState = presence.state;

  const render = (): void => {
    if (closed) return;
    const { rows, cols } = getSize();
    if (rows < HUD_HEIGHT + 1 || cols < 10) return;
    everRendered = true;
    const claudeBottom = rows - HUD_HEIGHT;
    const sepRow = rows - 1;
    const statusRow = rows;

    // Dashed separator — `╌` reads as a quiet dotted line, chrome-y
    // rather than load-bearing. Kept dim so the status strip is the
    // loudest element on the HUD rows.
    const separator = '╌'.repeat(cols);

    // Left: "csuite · ● <State>" — brand first, then dot adjacent to the
    // state word so the colored signal reads as a pair. All three
    // pieces keep their own palette tone so the chunk pops against
    // claude's frame above.
    const dot = dotColor(currentState);
    const stateWord = capitalize(currentState);
    const stateColor = stateColorFor(currentState);
    const leftPieces: Piece[] = [
      [`${BOLD}${BRAND}`, 'csuite'],
      ['', ' '],
      [SEPARATOR, '·'],
      ['', ' '],
      [dot, '●'],
      ['', ' '],
      [stateColor, stateWord],
    ];

    // The strip must land inside `cols`. Overflow doesn't merely clip:
    // the status row sits *below* the DECSTBM region set above, so the
    // implicit linefeed of an autowrap at the bottom row has nowhere to
    // scroll to — the tail wraps back onto column 1 of this same row and
    // overwrites the left padding, printing the end of the agent name in
    // the bottom-left corner. Widths are therefore derived from the
    // strings themselves rather than tallied by hand, and the label is
    // what yields when the terminal is too narrow to hold everything.
    const inner = Math.max(0, cols - PAD_LEFT - PAD_RIGHT);
    const leftWidth = width(leftPieces);
    const rightText = ellipsize(label, inner - leftWidth - MIN_GAP);
    const gap = Math.max(MIN_GAP, inner - leftWidth - rightText.length);

    const statusText = paint(
      [
        ['', ' '.repeat(PAD_LEFT)],
        ...leftPieces,
        ['', ' '.repeat(gap)],
        [AGENT_NAME, rightText],
        ['', ' '.repeat(PAD_RIGHT)],
      ],
      cols,
    );

    // Pin scroll region to claude's reported viewport so its newlines
    // stay in rows 1..(claudeBottom) and our HUD rows don't get pulled
    // upward. DECSTBM homes the cursor — we re-position before each
    // write below and restore the original cursor at the end.
    stdout.write(
      SAVE_CURSOR +
        decstbm(1, claudeBottom) +
        cup(sepRow, 1) +
        EL +
        DIM +
        SEPARATOR +
        separator +
        RESET_SGR +
        cup(statusRow, 1) +
        EL +
        statusText +
        RESET_SGR +
        RESTORE_CURSOR,
    );
  };

  // Presence and resize events only repaint if we've already done
  // the first render (which the caller triggers after claude's first
  // output chunk). Drawing before that would interleave our DECSTBM
  // + cursor-save/restore into claude's startup handshake and appear
  // to gate its first paint on a stray keypress.
  const onPresence = (next: PresenceState): void => {
    currentState = next;
    if (everRendered) render();
  };

  const onResize = (): void => {
    if (everRendered) render();
  };

  const unsubscribe = presence.subscribe(onPresence);
  stdout.on('resize', onResize);

  return {
    redraw: render,
    close(): void {
      if (closed) return;
      closed = true;
      stdout.off('resize', onResize);
      unsubscribe();
      // Clear the panel rows so the terminal returns to a clean
      // state on exit. Claude typically emits ESC[?1049l right
      // before we get here which drops us back to the main
      // buffer; the writes below hit the main buffer and would
      // otherwise leave our separator line floating above the
      // prompt.
      try {
        const { rows } = getSize();
        stdout.write(
          SAVE_CURSOR +
            DECSTBM_RESET +
            cup(rows - 1, 1) +
            EL +
            cup(rows, 1) +
            EL +
            RESTORE_CURSOR +
            RESET_SGR,
        );
      } catch {
        /* stdout might be gone already during shutdown */
      }
    },
  };
}

function dotColor(state: PresenceState): string {
  switch (state) {
    case 'online':
      return ONLINE;
    case 'offline':
      return OFFLINE;
    default:
      return CONNECTING;
  }
}

function stateColorFor(state: PresenceState): string {
  switch (state) {
    case 'online':
      return ONLINE;
    case 'offline':
      return OFFLINE;
    default:
      return CONNECTING;
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
