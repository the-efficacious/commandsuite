/**
 * Identity-tile glyphs — plate 14: two glyphs, display face, never
 * gold, no photos. Multi-word names take the first letter of the
 * first two words; single-word names take their first two characters.
 *
 * One implementation — this had grown four private copies before it
 * was extracted, which is exactly how glyph rules drift.
 */

export function initials(name: string): string {
  const parts = name.split(/[\s_-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}`.toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}
