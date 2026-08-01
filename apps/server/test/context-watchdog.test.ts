import type { GenAiInference } from 'csuite-sdk/types';
import { describe, expect, it } from 'vitest';
import {
  CONTEXT_PRESENCE_EVENT,
  contextResendBody,
  contextResendKey,
  inspectBriefingContext,
} from '../src/context-watchdog.js';

const inference = (system: string): Pick<GenAiInference, 'systemInstructions'> => ({
  systemInstructions: [{ type: 'text', content: system }],
});

describe('persistent context watchdog', () => {
  it('matches each block literally and emits telemetry whether or not resend fires', () => {
    const observations = inspectBriefingContext({
      memberName: 'Rune',
      inference: inference('the team has merge rules'),
      blocks: [
        { kind: 'team_context', text: 'the team has merge rules' },
        { kind: 'personal_instructions', text: 'merge only after an independent approval' },
      ],
      now: 1_000_000,
      lastResentAt: new Map(),
      systemProjectionObservable: true,
    });

    expect(observations.map((item) => [item.block.kind, item.present, item.resendFired])).toEqual([
      ['team_context', true, false],
      ['personal_instructions', false, true],
    ]);
    expect(observations.every((item) => item.telemetry.name === CONTEXT_PRESENCE_EVENT)).toBe(true);
    expect(contextResendBody(observations)).toContain('merge only after an independent approval');
    expect(contextResendBody(observations)).not.toContain('the team has merge rules');
  });

  it('does not accept a summary as an exact block and rate-limits repeated resend', () => {
    const block = { kind: 'team_context' as const, text: 'merge only after independent approval' };
    const first = inspectBriefingContext({
      memberName: 'Rune',
      inference: inference('the team has merge rules'),
      blocks: [block],
      now: 1_000_000,
      lastResentAt: new Map(),
      systemProjectionObservable: true,
    });
    const lastResentAt = new Map([
      [
        `Rune:${block.kind}:${first[0]?.telemetry.attributes['context.block.sha256'] as string}`,
        1_000_000,
      ],
    ]);
    const repeated = inspectBriefingContext({
      memberName: 'Rune',
      inference: inference('the team has merge rules'),
      blocks: [block],
      now: 1_000_001,
      lastResentAt,
      systemProjectionObservable: true,
    });

    expect(first[0]).toMatchObject({ present: false, resendFired: true });
    expect(repeated[0]).toMatchObject({ present: false, resendFired: false });
  });

  it('bypasses the cooldown when the next turn proves delivery did not land', () => {
    const block = { kind: 'team_context' as const, text: 'exact durable rules' };
    const key = contextResendKey('Rune', block);
    const [observation] = inspectBriefingContext({
      memberName: 'Rune',
      inference: inference('still absent'),
      blocks: [block],
      now: 1_000_001,
      lastResentAt: new Map([[key, 1_000_000]]),
      awaitingConfirmation: new Set([key]),
      systemProjectionObservable: true,
    });

    expect(observation).toMatchObject({
      present: false,
      resendFired: true,
      deliveryUnconfirmed: true,
    });
    expect(observation?.telemetry.attributes['context.block.delivery_unconfirmed']).toBe(true);
  });

  it('distinguishes a known issued prior version from a block that fell out', () => {
    const current = { kind: 'team_context' as const, text: 'current rules' };
    const [observation] = inspectBriefingContext({
      memberName: 'Rune',
      inference: inference('issued rules'),
      blocks: [current],
      now: 1_000_000,
      lastResentAt: new Map(),
      knownPriorVersions: new Map([['team_context', new Set(['issued rules'])]]),
      systemProjectionObservable: true,
    });

    expect(observation).toMatchObject({ present: false, priorVersionPresent: true });
    expect(observation?.telemetry.attributes).toMatchObject({
      'context.block.state': 'stale',
      'context.block.prior_version_present': true,
      'context.block.matched_prior_sha256': expect.any(String),
    });
  });

  it('reports an undeclared system projection as unobservable and never re-sends', () => {
    const [observation] = inspectBriefingContext({
      memberName: 'Rune',
      inference: { systemInstructions: [] },
      systemProjectionObservable: false,
      blocks: [{ kind: 'team_context', text: 'durable rules' }],
      now: 1_000_000,
      lastResentAt: new Map(),
    });

    expect(observation).toMatchObject({
      observable: false,
      present: null,
      resendFired: false,
    });
    expect(observation?.telemetry.attributes).toMatchObject({
      'context.block.observable': false,
      'context.block.state': 'unobservable',
    });
    expect(observation?.telemetry.attributes).not.toHaveProperty('context.block.present');
  });
});
