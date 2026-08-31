import type { SDKAssistantMessageError } from '@anthropic-ai/claude-agent-sdk';
import type { RunnerConditionCode } from 'csuite-sdk/types';

/**
 * The only user-facing text runner condition frames may carry. Raw adapter
 * errors are classified locally and discarded; they may contain credentials,
 * endpoints, URLs, or prompt fragments. Adding a condition code makes this
 * record fail the build until its fixed message is supplied.
 */
export const RUNNER_CONDITION_DETAIL: Record<RunnerConditionCode, string> = {
  no_credential: 'runner credential is unavailable',
  invalid_model: 'configured model id is invalid',
  model_unavailable: 'configured model is unavailable',
  server_overloaded: 'model service is overloaded',
  auth_blocked: 'runner credential is revoked',
  unknown: 'runner cannot complete turns',
};

/**
 * Claude already classifies assistant failures on the SDK message. Keep this
 * exhaustive so an SDK upgrade that adds an error cannot silently become
 * "nothing happened". The prose classifier below is compatibility enrichment
 * for emitters that predate this field; it is never the primary decision.
 */
const CLAUDE_ASSISTANT_ERROR_CONDITION: Record<SDKAssistantMessageError, RunnerConditionCode> = {
  authentication_failed: 'no_credential',
  oauth_org_not_allowed: 'no_credential',
  billing_error: 'unknown',
  rate_limit: 'server_overloaded',
  overloaded: 'server_overloaded',
  invalid_request: 'unknown',
  model_not_found: 'invalid_model',
  server_error: 'model_unavailable',
  unknown: 'unknown',
  max_output_tokens: 'unknown',
};

function structuredClaudeCondition(raw: unknown): RunnerConditionCode | null {
  if (raw === null || typeof raw !== 'object' || !('error' in raw)) return null;
  const error = (raw as { error?: unknown }).error;
  if (typeof error !== 'string') return null;
  // Runtime inputs can come from a newer SDK than the types compiled here.
  // An unrecognised typed error is still a degraded condition, never absence.
  return CLAUDE_ASSISTANT_ERROR_CONDITION[error as SDKAssistantMessageError] ?? 'unknown';
}

/**
 * Broker mail reached a terminal Claude result without reaching the model or
 * producing an effect. This is our failure fact, independent of vendor prose
 * and of the SDK's optional error label. Duration is deliberately absent:
 * measured credit-exhaustion failures span 0.83–1.45s, while model cost is the
 * axis that separates those failures from healthy prose-only turns.
 *
 * This is a fallback for zero-cost synthetic failures, not a definition of
 * inability. A typed SDK failure remains decisive even when it incurred cost.
 * Conversely, if an adapter removes its typed failure and returns a paid,
 * apparently successful prose response, that turn is observationally
 * identical here to a healthy prose-only answer and cannot be classified
 * without making model text a control surface. Because the turn completed,
 * the open-turn backstop does not cover that hypothetical either.
 */
export function isUnactedClaudeFailure(raw: unknown, acted: boolean): boolean {
  if (acted || raw === null || typeof raw !== 'object') return false;
  const result = raw as { total_cost_usd?: unknown };
  return result.total_cost_usd === 0;
}

/** Inspect locally, return only the bounded code. Never transmit `raw`. */
export function classifyRunnerFailure(raw: unknown): RunnerConditionCode {
  const structured = structuredClaudeCondition(raw);
  if (structured !== null) return structured;
  const text = typeof raw === 'string' ? raw.toLowerCase() : JSON.stringify(raw).toLowerCase();
  if (
    text.includes('serveroverloaded') ||
    text.includes('capacity') ||
    text.includes('overloaded')
  ) {
    return 'server_overloaded';
  }
  if (text.includes('model') && (text.includes('not found') || text.includes('invalid'))) {
    return 'invalid_model';
  }
  if (text.includes('model') && (text.includes('unavailable') || text.includes('unsupported'))) {
    return 'model_unavailable';
  }
  if (
    text.includes('credential') ||
    text.includes('unauthorized') ||
    text.includes('api key') ||
    text.includes('authentication')
  ) {
    return 'no_credential';
  }
  return 'unknown';
}
