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

/** Inspect locally, return only the bounded code. Never transmit `raw`. */
export function classifyRunnerFailure(raw: unknown): RunnerConditionCode {
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
