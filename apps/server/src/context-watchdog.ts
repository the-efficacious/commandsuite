import { createHash } from 'node:crypto';
import { redactSecrets } from 'csuite-core';
import type { GenAiInference } from 'csuite-sdk/types';
import type { InstructionBlock } from './instructions.js';
import type { TelemetryRecord } from './telemetry-store.js';

export const CONTEXT_RESEND_COOLDOWN_MS = 5 * 60 * 1000;
export const CONTEXT_PRESENCE_EVENT = 'csuite.context_block.presence';

export interface ContextBlockObservation {
  block: InstructionBlock;
  observable: boolean;
  present: boolean | null;
  /** Where the block was found, when it was. */
  presentIn: 'system_instructions' | 'input_messages' | null;
  resendFired: boolean;
  deliveryUnconfirmed: boolean;
  priorVersionPresent: boolean;
  telemetry: TelemetryRecord;
}

export function inspectInstructionContext(input: {
  memberName: string;
  inference: Pick<GenAiInference, 'systemInstructions' | 'inputMessages'>;
  systemProjectionObservable: boolean;
  blocks: readonly InstructionBlock[];
  now: number;
  lastResentAt: ReadonlyMap<string, number>;
  awaitingConfirmation?: ReadonlySet<string>;
  knownPriorVersions?: ReadonlyMap<InstructionBlock['kind'], ReadonlySet<string>>;
}): ContextBlockObservation[] {
  const system = input.inference.systemInstructions
    .map((part) => ('content' in part ? String(part.content ?? '') : ''))
    .join('');
  // A re-sent block arrives as a channel message, so on the NEXT
  // captured request it lives in `inputMessages` — often inside a tool
  // result — and never in the system projection, which a runner
  // composes once at session start. Delivery is therefore only
  // confirmable from the conversation: a projection-only search makes
  // every resend unconfirmable, and the unconfirmed bypass below then
  // re-fires on every captured request for the rest of the session.
  const conversation = conversationText(input.inference.inputMessages);
  // Redaction exemptions that keep briefing text verbatim in capture
  // are deliberately scoped to `system` (see otlp-parse / genai
  // mapping), so a conversation copy of a block containing
  // secret-shaped text is captured in its REDACTED form. Match either;
  // `redactSecrets` is the identity for text it has nothing to rewrite.
  const inConversation = (text: string): boolean => {
    if (conversation.includes(text)) return true;
    const redacted = redactSecrets(text);
    return redacted !== text && conversation.includes(redacted);
  };
  const observable = input.systemProjectionObservable;
  return input.blocks.map((block) => {
    const presentIn = system.includes(block.text)
      ? 'system_instructions'
      : inConversation(block.text)
        ? 'input_messages'
        : null;
    // Absence stays assertable only where the system projection is: an
    // unobservable projection (codex, #118) may hold the block, so a
    // conversation miss proves nothing there — but a conversation hit
    // is a hit whatever the projection declares.
    const present = presentIn !== null ? true : observable ? false : null;
    const key = `${input.memberName}:${block.kind}:${sha256(block.text)}`;
    const last = input.lastResentAt.get(key) ?? 0;
    const deliveryUnconfirmed =
      present === false && (input.awaitingConfirmation?.has(key) ?? false);
    const priorVersion =
      present !== false
        ? undefined
        : [...(input.knownPriorVersions?.get(block.kind) ?? [])].find(
            (candidate) =>
              candidate !== block.text &&
              (system.includes(candidate) || inConversation(candidate)),
          );
    const priorVersionPresent = priorVersion !== undefined;
    // STALE does not resend. A session holding a PRIOR version of the
    // block is restart-pending — the runner's drain-and-restart is the
    // remediation, and the broker's roster reports it meanwhile.
    // Re-injecting the new text would put two versions in one context
    // and re-fire every cooldown for the life of the frozen prompt.
    // MISSING still resends: the block fell out entirely (compaction,
    // an adapter gap), and recovery cannot wait for an edit to happen.
    const resendFired =
      present === false &&
      !priorVersionPresent &&
      (deliveryUnconfirmed || input.now - last >= CONTEXT_RESEND_COOLDOWN_MS);
    return {
      block,
      observable,
      present,
      presentIn,
      resendFired,
      deliveryUnconfirmed,
      priorVersionPresent,
      telemetry: {
        signal: 'log',
        name: CONTEXT_PRESENCE_EVENT,
        tsUnixNano: input.now * 1_000_000,
        attributes: {
          'context.block.kind': block.kind,
          'context.block.sha256': sha256(block.text),
          'context.block.resend_fired': resendFired,
          'context.block.delivery_unconfirmed': deliveryUnconfirmed,
          'context.block.observable': observable,
          'context.block.state':
            present === null
              ? 'unobservable'
              : present
                ? 'current'
                : priorVersionPresent
                  ? 'stale'
                  : 'missing',
          'context.block.prior_version_present': priorVersionPresent,
          ...(present !== null ? { 'context.block.present': present } : {}),
          ...(presentIn !== null ? { 'context.block.present_in': presentIn } : {}),
          ...(priorVersion !== undefined
            ? { 'context.block.matched_prior_sha256': sha256(priorVersion) }
            : {}),
        },
        resource: {},
        scope: { name: 'csuite.context-watchdog' },
        payload: { body: null, severityNumber: null, severityText: null },
      },
    };
  });
}

export function contextResendBody(observations: readonly ContextBlockObservation[]): string {
  const missing = observations.filter((item) => item.resendFired);
  return [
    'Persistent context was absent from your last captured request. Re-anchor on these exact blocks:',
    ...missing.flatMap(({ block }) => [
      `<persistent_context kind="${block.kind}">`,
      block.text,
      '</persistent_context>',
    ]),
  ].join('\n');
}

export function contextResendKey(memberName: string, block: InstructionBlock): string {
  return `${memberName}:${block.kind}:${sha256(block.text)}`;
}

/**
 * Every string reachable in the sent conversation, joined for
 * substring search. Parts are walked as values rather than by type: a
 * delivered channel message can land as message text or inside a
 * `tool_call_response` whose `response` is unknown-shaped, and
 * `String()` on such a value is '[object Object]', not its text.
 */
function conversationText(messages: GenAiInference['inputMessages']): string {
  const leaves: string[] = [];
  for (const message of messages) {
    for (const part of message.parts) collectStringLeaves(part, leaves);
  }
  return leaves.join('\n');
}

function collectStringLeaves(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringLeaves(item, out);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) collectStringLeaves(child, out);
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
