/**
 * Parse a human-readable duration string into milliseconds.
 *
 * Accepted shapes: `<number><unit>` with units `ms`, `s`, `m`, `h`, `d`.
 * Whitespace between the number and the unit is allowed. Case-
 * insensitive.
 *
 * Returns null for anything that doesn't match — callers should
 * surface a usage error with a suggested shape rather than silently
 * defaulting.
 *
 * Lives in its own file (rather than alongside the SQLite activity
 * store) so tests can exercise it under any Node version — the rest
 * of the server module graph transitively depends on `node:sqlite`,
 * which requires Node ≥22.
 */

export function parseDurationMs(input: string): number | null {
  const match = /^(\d+)\s*(ms|s|m|h|d)$/i.exec(input.trim());
  if (!match) return null;
  const n = Number.parseInt(match[1] ?? '', 10);
  if (!Number.isFinite(n) || n < 0) return null;
  const unit = (match[2] ?? '').toLowerCase();
  switch (unit) {
    case 'ms':
      return n;
    case 's':
      return n * 1000;
    case 'm':
      return n * 60_000;
    case 'h':
      return n * 60 * 60_000;
    case 'd':
      return n * 24 * 60 * 60_000;
    default:
      return null;
  }
}
