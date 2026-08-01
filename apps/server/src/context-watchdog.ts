import { createHash } from 'node:crypto';
import type { GenAiInference } from 'csuite-sdk/types';
import type { BriefingCaptureBlock } from './briefing.js';
import type { TelemetryRecord } from './telemetry-store.js';

export const CONTEXT_RESEND_COOLDOWN_MS = 5 * 60 * 1000;
export const CONTEXT_PRESENCE_EVENT = 'csuite.context_block.presence';

export interface ContextBlockObservation {
  block: BriefingCaptureBlock;
  observable: boolean;
  present: boolean | null;
  resendFired: boolean;
  deliveryUnconfirmed: boolean;
  priorVersionPresent: boolean;
  telemetry: TelemetryRecord;
}

export function inspectBriefingContext(input: {
  memberName: string;
  inference: Pick<GenAiInference, 'systemInstructions'>;
  systemProjectionObservable: boolean;
  blocks: readonly BriefingCaptureBlock[];
  now: number;
  lastResentAt: ReadonlyMap<string, number>;
  awaitingConfirmation?: ReadonlySet<string>;
  knownPriorVersions?: ReadonlyMap<BriefingCaptureBlock['kind'], ReadonlySet<string>>;
}): ContextBlockObservation[] {
  const system = input.inference.systemInstructions
    .map((part) => ('content' in part ? String(part.content ?? '') : ''))
    .join('');
  const observable = input.systemProjectionObservable;
  return input.blocks.map((block) => {
    const present = observable ? system.includes(block.text) : null;
    const key = `${input.memberName}:${block.kind}:${sha256(block.text)}`;
    const last = input.lastResentAt.get(key) ?? 0;
    const deliveryUnconfirmed =
      present === false && (input.awaitingConfirmation?.has(key) ?? false);
    const priorVersion =
      present !== false
        ? undefined
        : [...(input.knownPriorVersions?.get(block.kind) ?? [])].find(
            (candidate) => candidate !== block.text && system.includes(candidate),
          );
    const priorVersionPresent = priorVersion !== undefined;
    const resendFired =
      present === false && (deliveryUnconfirmed || input.now - last >= CONTEXT_RESEND_COOLDOWN_MS);
    return {
      block,
      observable,
      present,
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

export function contextResendKey(memberName: string, block: BriefingCaptureBlock): string {
  return `${memberName}:${block.kind}:${sha256(block.text)}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
