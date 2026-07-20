import { describe, expect, it } from 'vitest';
import { parseDurationMs } from '../src/duration.js';

describe('parseDurationMs', () => {
  it('parses ms, s, m, h, d', () => {
    expect(parseDurationMs('500ms')).toBe(500);
    expect(parseDurationMs('30s')).toBe(30_000);
    expect(parseDurationMs('5m')).toBe(5 * 60_000);
    expect(parseDurationMs('2h')).toBe(2 * 60 * 60_000);
    expect(parseDurationMs('30d')).toBe(30 * 24 * 60 * 60_000);
  });

  it('is case-insensitive', () => {
    expect(parseDurationMs('24H')).toBe(24 * 60 * 60_000);
    expect(parseDurationMs('1D')).toBe(24 * 60 * 60_000);
  });

  it('tolerates whitespace between number and unit', () => {
    expect(parseDurationMs('30 d')).toBe(30 * 24 * 60 * 60_000);
    expect(parseDurationMs('  30d  ')).toBe(30 * 24 * 60 * 60_000);
  });

  it('returns null for malformed input', () => {
    expect(parseDurationMs('30')).toBeNull();
    expect(parseDurationMs('d')).toBeNull();
    expect(parseDurationMs('30x')).toBeNull();
    expect(parseDurationMs('thirty days')).toBeNull();
    expect(parseDurationMs('')).toBeNull();
  });

  it('returns null for negative / non-finite', () => {
    expect(parseDurationMs('-1d')).toBeNull();
  });

  it('accepts zero', () => {
    expect(parseDurationMs('0d')).toBe(0);
    expect(parseDurationMs('0s')).toBe(0);
  });
});
