/**
 * Sender color — person vs agent, per Helm plate 14 (MARK SPEC).
 *
 * The axis is identity KIND, not self-vs-other: a hue hashed per
 * name (or split by viewer) teaches the eye that color is decoration,
 * and the moment it does, an amber dot stops meaning amber. Identity
 * is the one place hue is spent on a person — person names take the
 * identity blue; agent names take primary text (neutral by decision:
 * the tile already carries the distinction, and the mock's gold agent
 * names were recorded as an error in the token derivation).
 *
 * `undefined` (older server, no kind on the roster) fails toward the
 * neutral agent treatment — never toward fake person-blue.
 */

export function senderTextClass(kind: 'person' | 'agent' | undefined): string {
  return kind === 'person' ? 'text-ef-identity-person' : 'text-ef-identity-agent';
}
