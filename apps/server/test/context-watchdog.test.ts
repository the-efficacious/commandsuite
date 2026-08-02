import type { GenAiInference, GenAiMessage } from 'csuite-sdk/types';
import { describe, expect, it } from 'vitest';
import {
  CONTEXT_PRESENCE_EVENT,
  contextResendBody,
  contextResendKey,
  inspectInstructionContext,
} from '../src/context-watchdog.js';

const inference = (
  system: string,
  messages: GenAiMessage[] = [],
): Pick<GenAiInference, 'systemInstructions' | 'inputMessages'> => ({
  systemInstructions: [{ type: 'text', content: system }],
  inputMessages: messages,
});

const userText = (text: string): GenAiMessage => ({
  role: 'user',
  parts: [{ type: 'text', content: text }],
});

describe('persistent context watchdog', () => {
  it('matches each block literally and emits telemetry whether or not resend fires', () => {
    const observations = inspectInstructionContext({
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
    const first = inspectInstructionContext({
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
    const repeated = inspectInstructionContext({
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
    const [observation] = inspectInstructionContext({
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
    const [observation] = inspectInstructionContext({
      memberName: 'Rune',
      inference: inference('issued rules'),
      blocks: [current],
      now: 1_000_000,
      lastResentAt: new Map(),
      knownPriorVersions: new Map([['team_context', new Set(['issued rules'])]]),
      systemProjectionObservable: true,
    });

    // Stale never resends — restart is the remediation; the resend is
    // reserved for `missing` (the block fell out entirely).
    expect(observation).toMatchObject({
      present: false,
      priorVersionPresent: true,
      resendFired: false,
    });
    expect(observation?.telemetry.attributes).toMatchObject({
      'context.block.state': 'stale',
      'context.block.prior_version_present': true,
      'context.block.matched_prior_sha256': expect.any(String),
    });
  });

  it('reports an undeclared system projection as unobservable and never re-sends', () => {
    const [observation] = inspectInstructionContext({
      memberName: 'Rune',
      inference: { systemInstructions: [], inputMessages: [] },
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

// ─── delivery confirmation reads the conversation ────────────────────
//
// A re-sent block arrives as a channel message: on the next captured
// request it is in `inputMessages`, never in the system projection,
// which the runner composed once at session start. A projection-only
// search therefore could not confirm any resend, `awaitingConfirmation`
// never cleared, and the unconfirmed bypass re-fired the same notice on
// every captured request for the rest of the session. Observed live on
// 2026-08-01: three identical "persistent context restored" notices in
// 65 seconds after a mid-session team-context edit.

describe('delivery confirmation reads the conversation', () => {
  const block = { kind: 'team_context' as const, text: 'exact durable rules' };
  const resendEnvelope = `<persistent_context kind="team_context">\n${block.text}\n</persistent_context>`;

  it('confirms a resend from the conversation and closes the unconfirmed loop', () => {
    const key = contextResendKey('Lea', block);
    const [observation] = inspectInstructionContext({
      memberName: 'Lea',
      // Frozen prompt still lacks the block; the previous turn's resend
      // is in the conversation, inside the channel envelope.
      inference: inference('a prompt composed before the edit', [userText(resendEnvelope)]),
      blocks: [block],
      now: 1_000_002,
      lastResentAt: new Map([[key, 1_000_000]]),
      awaitingConfirmation: new Set([key]),
      systemProjectionObservable: true,
    });

    expect(observation).toMatchObject({
      present: true,
      presentIn: 'input_messages',
      resendFired: false,
      deliveryUnconfirmed: false,
    });
    expect(observation?.telemetry.attributes).toMatchObject({
      'context.block.state': 'current',
      'context.block.present_in': 'input_messages',
    });
  });

  it('finds a block delivered inside a tool result, whatever shape the response takes', () => {
    const [observation] = inspectInstructionContext({
      memberName: 'Lea',
      inference: {
        systemInstructions: [{ type: 'text', content: 'a prompt without the block' }],
        inputMessages: [
          {
            role: 'user',
            parts: [
              {
                type: 'tool_call_response',
                id: 'toolu_01',
                is_error: false,
                // Anthropic-shaped nested blocks, as `unknown` — the
                // form a mid-turn channel message actually arrives in.
                response: [{ type: 'text', text: `tool output\n${resendEnvelope}` }],
              },
            ],
          },
        ],
      },
      blocks: [block],
      now: 1_000_000,
      lastResentAt: new Map(),
      systemProjectionObservable: true,
    });

    expect(observation).toMatchObject({ present: true, presentIn: 'input_messages' });
  });

  it('asserts presence from the conversation even when the projection is unobservable', () => {
    const [observation] = inspectInstructionContext({
      memberName: 'Seamus',
      inference: { systemInstructions: [], inputMessages: [userText(resendEnvelope)] },
      systemProjectionObservable: false,
      blocks: [block],
      now: 1_000_000,
      lastResentAt: new Map(),
    });

    expect(observation).toMatchObject({
      observable: false,
      present: true,
      presentIn: 'input_messages',
    });
    expect(observation?.telemetry.attributes['context.block.state']).toBe('current');
  });

  it('still cannot assert absence when the projection is unobservable', () => {
    const [observation] = inspectInstructionContext({
      memberName: 'Seamus',
      inference: { systemInstructions: [], inputMessages: [userText('unrelated chatter')] },
      systemProjectionObservable: false,
      blocks: [block],
      now: 1_000_000,
      lastResentAt: new Map(),
    });

    expect(observation).toMatchObject({ present: null, resendFired: false });
  });

  it('does not accept a conversational paraphrase as the exact block', () => {
    const [observation] = inspectInstructionContext({
      memberName: 'Lea',
      inference: inference('a prompt without the block', [
        userText('the durable rules say roughly: be exact'),
      ]),
      blocks: [block],
      now: 1_000_000,
      lastResentAt: new Map(),
      systemProjectionObservable: true,
    });

    expect(observation).toMatchObject({ present: false, resendFired: true });
  });

  it('matches the redacted form a conversation copy is captured in', () => {
    // Conversation content is redacted WITHOUT the packet exemptions
    // (those are deliberately scoped to `system`), so a block carrying
    // secret-shaped text arrives in capture with that span rewritten.
    const secretBlock = {
      kind: 'personal_instructions' as const,
      text: 'Use the broker token sk-ant-abcdefghij0123456789 for enrollment',
    };
    const capturedCopy = 'Use the broker token [REDACTED] for enrollment';
    const [observation] = inspectInstructionContext({
      memberName: 'Lea',
      inference: inference('a prompt without the block', [userText(capturedCopy)]),
      blocks: [secretBlock],
      now: 1_000_000,
      lastResentAt: new Map(),
      systemProjectionObservable: true,
    });

    expect(observation).toMatchObject({ present: true, presentIn: 'input_messages' });
  });

  it('prefers naming the system projection when the block is in both', () => {
    const [observation] = inspectInstructionContext({
      memberName: 'Lea',
      inference: inference(`prompt with ${block.text}`, [userText(resendEnvelope)]),
      blocks: [block],
      now: 1_000_000,
      lastResentAt: new Map(),
      systemProjectionObservable: true,
    });

    expect(observation).toMatchObject({ present: true, presentIn: 'system_instructions' });
  });
});
