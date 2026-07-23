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

/** Foreground color via truecolor SGR. */
function fg(r: number, g: number, b: number): string {
  return `${CSI}38;2;${r};${g};${b}m`;
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

// Palette — same hex values as apps/web-host/src/theme.css so the
// terminal HUD reads visually like a sibling of the web UI chrome.
// The separator stays as muted chrome; the status text itself pops
// in saturated palette tones so "online / offline" reads at a glance.
const ONLINE = fg(0x63, 0x89, 0xa6); // glacier — bright, calm, trusted
const OFFLINE = fg(0xc8, 0x7c, 0x4e); // ember — alert weight
const CONNECTING = fg(0x89, 0xa0, 0xb8); // pale glacier — transient
const BRAND = fg(0x3e, 0x5c, 0x76); // steel — load-bearing "csuite" word
const AGENT_NAME = fg(0xa4, 0xbd, 0xd1); // frost — airy right-side label
const SEPARATOR = fg(0x7b, 0x85, 0x91); // slate — chrome

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
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
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
    const leftChunk =
      `${BOLD}${BRAND}csuite${RESET_SGR} ${SEPARATOR}·${RESET_SGR} ` +
      `${dot}●${RESET_SGR} ${stateColor}${stateWord}${RESET_SGR}`;
    // Visible width: '  ' (2) + 'csuite' (3) + ' · ' (3) + '●' (1) + ' ' (1) + stateWord (n)
    const leftVisible = 2 + 3 + 3 + 1 + 1 + stateWord.length;

    // Right: agent name in frost. Padded with two trailing spaces
    // so the label isn't jammed against the terminal edge.
    const rightPlain = label;
    const rightChunk = `${AGENT_NAME}${rightPlain}${RESET_SGR}`;
    const rightVisible = rightPlain.length;

    const gap = Math.max(1, cols - leftVisible - rightVisible - 2);
    const statusText = `  ${leftChunk}${' '.repeat(gap)}${rightChunk} `;

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
