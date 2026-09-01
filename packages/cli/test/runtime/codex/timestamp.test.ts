import { describe, expect, it } from 'vitest';

import { codexTurnTimestampMs } from '../../../src/runtime/agents/codex/adapter.js';

describe('codexTurnTimestampMs', () => {
  it('converts app-server Unix seconds before the exitability backstop sees them', () => {
    expect(codexTurnTimestampMs(1_788_213_445)).toBe(1_788_213_445_000);
  });

  it('leaves Unix milliseconds unchanged', () => {
    expect(codexTurnTimestampMs(1_788_213_445_123)).toBe(1_788_213_445_123);
  });

  it('uses the measured local time when the app-server timestamp is absent or invalid', () => {
    expect(codexTurnTimestampMs(undefined, 123_456)).toBe(123_456);
    expect(codexTurnTimestampMs(Number.NaN, 123_456)).toBe(123_456);
  });
});
