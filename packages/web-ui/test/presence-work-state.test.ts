/**
 * `presenceWorkState` — the single place the web shell decides how to
 * read the roster's projected state of work.
 *
 * The wire field `Presence.activity` was renamed to `Presence.workState`
 * and, for one release, the broker emits both. This shell therefore has
 * to resolve THREE spellings and get their order right:
 *
 *     workState   canonical
 *     activity    the previous name, removed in the next minor
 *     busy        the older boolean, which cannot express `blocked`
 *
 * The order is the part with teeth. `busy` is lossy by construction —
 * `busy: true` means `working` and there is no encoding of `blocked` at
 * all — so a reader that consulted it before the enum would render a
 * member who is asking a human for input as merely online. That member
 * is the one the whole signal exists for.
 *
 * The rendering tests in `shell.test.tsx` cover the same precedence
 * through the DOM; these are on the function, because it is what both
 * roster surfaces call and a divergence between them starts here.
 */

import type { Presence } from 'csuite-sdk/types';
import { describe, expect, it } from 'vitest';
import { presenceWorkState } from '../src/lib/roster.js';

function presence(fields: Partial<Presence>): Presence {
  return { name: 'turner', connected: 1, createdAt: 0, lastSeen: 0, role: null, ...fields };
}

describe('presenceWorkState', () => {
  it('reads the canonical workState field', () => {
    expect(presenceWorkState(presence({ workState: 'blocked' }))).toBe('blocked');
    expect(presenceWorkState(presence({ workState: 'working' }))).toBe('working');
    expect(presenceWorkState(presence({ workState: 'idle' }))).toBe('idle');
  });

  it('falls back to the previous activity field for an older broker', () => {
    // A broker that predates the rename sends only this one. Dropping the
    // fallback would silently blank the work column for every member
    // on such a broker.
    expect(presenceWorkState(presence({ activity: 'blocked' }))).toBe('blocked');
    expect(presenceWorkState(presence({ activity: 'working' }))).toBe('working');
  });

  it('prefers workState when a compat-window broker sends both, disagreeing', () => {
    // During the compat window every broker sends BOTH. Equal values
    // cannot distinguish the two orders, so the values here disagree
    // on purpose: only a workState-first reader answers `blocked`.
    expect(presenceWorkState(presence({ workState: 'blocked', activity: 'working' }))).toBe(
      'blocked',
    );
    expect(presenceWorkState(presence({ workState: 'working', activity: 'blocked' }))).toBe(
      'working',
    );
  });

  it('prefers either enum over the lossy busy boolean', () => {
    // `busy: false` beside `blocked` is exactly what the broker emits —
    // `busy` mirrors `workState === "working"`, so a blocked member's
    // boolean reads false. A reader that consulted `busy` first would
    // call that member idle and hide the request for a human.
    expect(presenceWorkState(presence({ workState: 'blocked', busy: false }))).toBe('blocked');
    expect(presenceWorkState(presence({ activity: 'blocked', busy: false }))).toBe('blocked');
  });

  it('reads the boolean only when neither enum is present', () => {
    expect(presenceWorkState(presence({ busy: true }))).toBe('working');
    expect(presenceWorkState(presence({ busy: false }))).toBe('idle');
  });

  it('treats an absent field and an absent member alike, as idle', () => {
    // Idle is the benign default for this signal — deliberately the
    // OPPOSITE rule from `presenceCaptureWarning`, where absence means
    // the broker has no opinion and must never read as healthy.
    expect(presenceWorkState(presence({}))).toBe('idle');
    expect(presenceWorkState(undefined)).toBe('idle');
  });
});
