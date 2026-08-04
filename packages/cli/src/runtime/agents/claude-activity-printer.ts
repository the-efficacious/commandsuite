/**
 * Claude activity printer — renders the Agent SDK's message stream as
 * human-readable lines on a write stream (default `process.stderr`).
 *
 * The SDK runner is headless: Claude Code runs as a stream-json
 * subprocess and paints no terminal UI of its own. Without this module
 * the operator running `csuite claude` sees a startup banner and then
 * nothing. Same rationale — and same visual chrome — as the codex
 * activity printer.
 *
 * What this prints (per turn the agent runs):
 *
 *   ▸ turn
 *      ⚒ Bash
 *      ⚒ mcp__csuite__objectives_list
 *      assistant: Found the issue. The shape of the merge in…
 *      └─ done · 12.4s · 3 tools · $0.18
 *
 * Assistant text arrives as complete blocks (partial-message streaming
 * is off in the runner), so prose prints block-at-a-time. Thinking
 * blocks render as a marker only — the content is captured in the
 * activity stream, not echoed to the operator. Subagent traffic
 * (`parent_tool_use_id` set) is counted but not printed; the top-level
 * turn line is the operator signal.
 *
 * Output:
 *   - ANSI 24-bit colors when `stream.isTTY` (palette matches
 *     `runtime/hud.ts` so the printer reads as the same chrome).
 *   - Plain ASCII when not a TTY — CI logs stay grep-friendly.
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { helm } from '@the-efficacious/brand';

// ── Palette — Helm roles from @the-efficacious/brand ────────────────

const CSI = '\x1b[';
const RESET = `${CSI}0m`;
/** '#rrggbb' → truecolor foreground escape. */
function fg(hex: string | undefined): string {
  if (!hex) throw new Error('missing brand role — check the @the-efficacious/brand version');
  const n = Number.parseInt(hex.slice(1), 16);
  return `${CSI}38;2;${(n >> 16) & 0xff};${(n >> 8) & 0xff};${n & 0xff}m`;
}
// Helm roles resolved to concrete RGB at build time (tsup inlines the
// brand package). Dark-terminal palette — helm is dark-native.
const PALETTE = {
  accent: fg(helm.color.lampWorking), // live-activity blue
  agent: fg(helm.color.textSecondary), // assistant prefix
  muted: fg(helm.color.textMuted), // chrome glyphs
  alarm: fg(helm.color.lampAlarm), // error / alert
  body: fg(helm.color.text), // body text
};

const INDENT = '   ';

export interface ClaudeActivityPrinterOptions {
  /** Where to write activity lines. Defaults to `process.stderr`. */
  stream?: NodeJS.WriteStream;
  /**
   * Force color on/off. Defaults to `stream.isTTY`. Tests pin to
   * `false` for stable string comparison.
   */
  color?: boolean;
}

export interface ClaudeActivityPrinter {
  /** Feed one SDK message. Unknown message types are ignored. */
  handle(message: SDKMessage): void;
  /** Stop printing. Idempotent. */
  close(): void;
}

interface TurnState {
  startedAtMs: number;
  toolCount: number;
}

export function createClaudeActivityPrinter(
  options: ClaudeActivityPrinterOptions = {},
): ClaudeActivityPrinter {
  const stream = options.stream ?? process.stderr;
  const color = options.color ?? Boolean(stream.isTTY);

  const paint = (code: string, text: string): string => (color ? `${code}${text}${RESET}` : text);
  const write = (s: string): void => {
    stream.write(s);
  };

  let closed = false;
  let turn: TurnState | null = null;

  const openTurn = (): TurnState => {
    if (turn === null) {
      turn = { startedAtMs: Date.now(), toolCount: 0 };
      write(`\n${paint(PALETTE.accent, '▸')} ${paint(PALETTE.muted, 'turn')}\n`);
    }
    return turn;
  };

  return {
    handle(message: SDKMessage): void {
      if (closed) return;
      switch (message.type) {
        case 'assistant': {
          // Subagent traffic: count tools toward the turn, skip prose.
          const isSubagent = message.parent_tool_use_id !== null;
          const state = openTurn();
          for (const block of message.message.content) {
            if (block.type === 'tool_use') {
              state.toolCount++;
              if (!isSubagent) {
                write(`${INDENT}${paint(PALETTE.muted, '⚒')} ${paint(PALETTE.body, block.name)}\n`);
              }
            } else if (block.type === 'text' && !isSubagent && block.text.trim().length > 0) {
              const text = firstLines(block.text.trim(), 6);
              write(
                `${INDENT}${paint(PALETTE.agent, 'assistant:')} ${paint(PALETTE.body, text.replaceAll('\n', `\n${INDENT}`))}\n`,
              );
            } else if (block.type === 'thinking' && !isSubagent) {
              write(`${INDENT}${paint(PALETTE.muted, '∴ thinking…')}\n`);
            }
          }
          break;
        }
        case 'result': {
          const state = turn;
          turn = null;
          const seconds = (message.duration_ms / 1000).toFixed(1);
          const cost =
            typeof message.total_cost_usd === 'number'
              ? ` · $${message.total_cost_usd.toFixed(2)}`
              : '';
          const tools = state !== null && state.toolCount > 0 ? ` · ${state.toolCount} tools` : '';
          if (message.subtype === 'success') {
            write(`${INDENT}${paint(PALETTE.muted, `└─ done · ${seconds}s${tools}${cost}`)}\n`);
          } else {
            write(
              `${INDENT}${paint(PALETTE.alarm, `└─ ${message.subtype} · ${seconds}s${tools}${cost}`)}\n`,
            );
          }
          break;
        }
        case 'system': {
          if (message.subtype === 'status' && message.status === 'compacting') {
            write(`${INDENT}${paint(PALETTE.muted, '· compacting context…')}\n`);
          }
          break;
        }
        default:
          break;
      }
    },
    close(): void {
      closed = true;
    },
  };
}

/** First `n` lines of `text`, with a muted ellipsis marker when cut. */
function firstLines(text: string, n: number): string {
  const lines = text.split('\n');
  if (lines.length <= n) return text;
  return `${lines.slice(0, n).join('\n')}\n…`;
}
