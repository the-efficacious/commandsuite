/**
 * ULIDs for annex events — `evt_<ulid>`.
 *
 * WHY NOT `randomUUID`, which this repo already uses everywhere else.
 * A v4 UUID is unordered, and an event id that does not sort is an id
 * that cannot be read as a cursor, cannot be eyeballed in `seq` order,
 * and makes every "what happened around this one" question a join. The
 * annex's whole shape is a stream, so its ids sort like the stream.
 *
 * WHY NOT A DEPENDENCY. The generator is twenty lines of Crockford
 * base32 over `crypto.getRandomValues`, and this repo adds no package
 * it can write in twenty lines.
 *
 * MONOTONIC WITHIN A MILLISECOND. Two events appended in the same
 * millisecond — which happens on every multi-event fixture and on any
 * batched write — would otherwise sort by their random tails, i.e.
 * arbitrarily. So a same-millisecond id increments the previous
 * randomness instead of redrawing it, and ties break in append order.
 * `seq` remains the authority on ordering; this just stops the id from
 * disagreeing with it.
 */

/** Crockford base32: no I, L, O or U, so a transcribed id cannot be misread. */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;

let lastTime = -1;
let lastRandom: number[] = [];

function encodeTime(ms: number): string {
  let remaining = ms;
  const out = new Array<string>(TIME_CHARS);
  for (let i = TIME_CHARS - 1; i >= 0; i--) {
    const mod = remaining % 32;
    out[i] = ENCODING[mod] as string;
    remaining = (remaining - mod) / 32;
  }
  return out.join('');
}

function drawRandom(): number[] {
  const bytes = new Uint8Array(RANDOM_CHARS);
  globalThis.crypto.getRandomValues(bytes);
  // One byte per character, folded into the 32-symbol alphabet. Five
  // bits of the eight survive, which is the standard ULID trade and
  // still leaves 80 bits of randomness across the sixteen characters.
  return Array.from(bytes, (b) => b % 32);
}

/**
 * Increment the previous randomness in place, carrying left.
 *
 * Overflow (sixteen characters all at max, in one millisecond) redraws
 * rather than throwing: an id that is merely out of order is a
 * cosmetic defect, and refusing to append would be a real one.
 */
function incrementRandom(prev: number[]): number[] {
  const next = prev.slice();
  for (let i = next.length - 1; i >= 0; i--) {
    const value = (next[i] as number) + 1;
    if (value < 32) {
      next[i] = value;
      return next;
    }
    next[i] = 0;
  }
  return drawRandom();
}

/** A ULID for `at`. Monotonic against the previous call in the same millisecond. */
export function ulid(at: number = Date.now()): string {
  const time = Math.floor(at);
  if (time === lastTime) {
    lastRandom = incrementRandom(lastRandom);
  } else {
    lastTime = time;
    lastRandom = drawRandom();
  }
  return encodeTime(time) + lastRandom.map((n) => ENCODING[n] as string).join('');
}

/** An annex event id. The prefix is what makes a bare id readable in a citation. */
export function eventId(at?: number): string {
  return `evt_${ulid(at)}`;
}

/** A revision id. Revisions are observation points, not events, so they carry their own prefix. */
export function revisionId(at?: number): string {
  return `rev_${ulid(at)}`;
}
