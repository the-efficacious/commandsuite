/**
 * Shared time formatting for list rows and meta lines.
 *
 * `relativeTime` is deliberately coarse — single unit, no "3 hours,
 * 12 minutes" — because it decorates rows the eye is scanning, not
 * records. Pair it with `absoluteTime` in a `title` attribute so the
 * precise stamp is one hover away instead of cluttering the row.
 */

/** "now", "5m", "3h", "2d" — coarse age of an epoch-ms timestamp. */
export function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

/** "2026-08-12 14:03" in local time — for title-attribute tooltips. */
export function absoluteTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
