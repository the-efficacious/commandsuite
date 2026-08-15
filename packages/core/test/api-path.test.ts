/**
 * Which paths are API, and therefore must 404 as JSON.
 *
 * `isApiPath` decides whether an unmatched GET falls through to the
 * host's SPA. Anything it does not claim answers `index.html` with a
 * 200 — so a client asking for JSON gets HTML and no error, which is
 * strictly worse than a 404 because it looks like success.
 *
 * `/members` was missing from the list while the retired `/agents`
 * spelling was still in it. Every member sub-resource — activity,
 * gen_ai, telemetry, raw bodies — was therefore SPA-shadowed whenever
 * its store was unwired or its id was wrong.
 *
 * Both directions are asserted. A predicate that returns `true` for
 * everything satisfies every "is API" case on its own, and would break
 * the SPA entirely.
 */

import { describe, expect, it } from 'vitest';
import { isApiPath } from '../src/app.js';

describe('member sub-resources are API paths', () => {
  it.each([
    '/members',
    '/members/build-bot',
    '/members/build-bot/activity',
    '/members/build-bot/activity/stream',
    '/members/build-bot/genai',
    '/members/build-bot/genai/42',
    '/members/build-bot/genai/42/raw',
    '/members/build-bot/telemetry',
    '/members/build-bot/tokens',
    '/members/build-bot/context',
  ])('claims %s', (path) => {
    expect(isApiPath(path)).toBe(true);
  });
});

describe('the rest of the API surface still resolves', () => {
  it.each([
    '/healthz',
    '/roster',
    '/history',
    '/objectives',
    '/notifications',
    '/otlp/v1/logs',
    '/fs/objective/x',
    '/presence/activity',
  ])('claims %s', (path) => {
    expect(isApiPath(path)).toBe(true);
  });
});

describe('client-side routes still reach the SPA', () => {
  it.each(['/login', '/dm/build-bot', '/channels/general', '/settings', '/'])(
    'does not claim %s',
    (path) => {
      // The positive control for the whole predicate: if this ever
      // starts failing, the host stops serving its own app.
      expect(isApiPath(path)).toBe(false);
    },
  );

  it('does not claim the retired /agents spelling', () => {
    // `/agents` was the old name for `/members` and routes nothing.
    // Leaving it listed meant a client-side route under that prefix
    // would 404 instead of loading the app.
    expect(isApiPath('/agents')).toBe(false);
    expect(isApiPath('/agents/build-bot')).toBe(false);
  });

  it('does not claim a path that merely starts with an API word', () => {
    // Guards the prefix match itself: `/membership` is not `/members`.
    expect(isApiPath('/membership')).toBe(false);
  });
});
