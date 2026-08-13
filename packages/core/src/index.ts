/**
 * `csuite-core` — runtime-agnostic broker logic.
 *
 * Everything in here must be portable across JavaScript runtimes. No
 * `node:` imports, no fs, no http. Persistence/IO is injected via the
 * `EventLog` interface.
 */

export {
  type ActivityListener,
  type ActivityStore,
  clampListLimit,
  InMemoryActivityStore,
  type InMemoryActivityStoreOptions,
  type ListActivityFilter,
} from './activity-store.js';
export {
  Broker,
  type BrokerLogger,
  type BrokerOptions,
  type IdentityContext,
  InvalidRecipientError,
  type PushContext,
  type RegistrationResult,
} from './broker.js';
export {
  CAPTURE_GRACE_MS,
  type CaptureHealth,
  type CaptureHealthOptions,
  type CaptureHealthStore,
  createCaptureHealthStore,
} from './capture-health.js';
export {
  type Channel,
  type ChannelMember,
  type ChannelMemberRole,
  type ChannelStore,
  ChannelsError,
  createSqliteChannelStore,
  GENERAL_CHANNEL_SLUG,
  validateSlug,
} from './channels.js';
export {
  type Attribution,
  type CauseSpec,
  type Coverage,
  causeSpec,
  classifyError,
  createDiagnosticStore,
  createDiagnosticStoreInternalForTests,
  DIAGNOSTIC_CAUSES,
  type DiagnosticCause,
  type DiagnosticEmitter,
  type DiagnosticInput,
  type DiagnosticOptions,
  type DiagnosticStore,
  type DiagnosticWindowResult,
  digestPath,
  type FieldPolicy,
  type HealthMode,
  healthMode,
  type RetentionHealth,
  type SafeFields,
  safeCount,
  safeError,
  safeFields,
  safeHash,
} from './diagnostics.js';
export { parseDurationMs } from './duration.js';
export {
  CHANNEL_THREAD_PREFIX,
  channelThreadTag,
  clampQueryLimit,
  DEFAULT_QUERY_LIMIT,
  type EventLog,
  type EventLogQueryOptions,
  type EventLogTailOptions,
  GENERAL_CHANNEL_ID,
  InMemoryEventLog,
  isSecretThread,
  MAX_QUERY_LIMIT,
  SECRET_THREAD_PREFIX,
} from './event-log.js';
export {
  createGenAiStore,
  type GenAiInferenceInput,
  type GenAiInferenceRow,
  type GenAiQuery,
  type GenAiStore,
  type GenAiStoreOptions,
} from './genai-store.js';
export { constantTimeEqual, sha256Hex } from './hashing.js';
export { type LogContext, type Logger, logger } from './logger.js';
export {
  createSqliteActivityStore,
  pruneActivityDb,
  type SqliteActivityStoreHandle,
} from './member-activity.js';
export {
  createSqliteObjectivesStore,
  ObjectivesError,
  type ObjectivesMutationResult,
  type ObjectivesStore,
} from './objectives.js';
export {
  assertDocumentInvariants,
  createSqliteProcessDocumentStore,
  type EditableFields,
  ProcessDocumentError,
  type ProcessDocumentStore,
} from './process-document.js';
export {
  InMemoryPushSubscriptionStore,
  type InMemoryPushSubscriptionStoreOptions,
  type PushSubscriptionInput,
  type PushSubscriptionRow,
  type PushSubscriptionStore,
} from './push-subscription-store.js';
export { randomBase64Url, toBase64Url } from './random-id.js';
export {
  PresenceIdentityError,
  PresenceRegistry,
  type PresenceState,
  type Subscriber,
} from './registry.js';
export {
  InMemorySessionStore,
  type InMemorySessionStoreOptions,
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  type SessionRow,
  type SessionStore,
} from './session-store.js';
export type {
  SqlDriver,
  SqlRunResult,
  SqlStatement,
  SqlValue,
} from './sql-driver.js';
export { SqliteEventLog } from './sqlite-event-log.js';
export { SqlitePushSubscriptionStore } from './sqlite-push-subscription-store.js';
export { SqliteSessionStore } from './sqlite-session-store.js';
export {
  createTokenStoreFromMembers,
  SqliteTokenStore,
  type TokenSeedMemberSource,
} from './sqlite-token-store.js';
export {
  createTelemetryStore,
  type TelemetryQuery,
  type TelemetryRecord,
  type TelemetryRow,
  type TelemetryStore,
  type TelemetryStoreOptions,
} from './telemetry-store.js';
export {
  generateBearerToken,
  hashRawToken,
  type InsertHashedTokenInput,
  type InsertTokenInput,
  type InternalTokenRow,
  TOKEN_HASH_PREFIX,
  type TokenStore,
} from './token-store.js';
// Pure trace parsers — relocated here from the cli so both the cli
// native-capture adapters and the server can import them without the
// server depending on packages/cli. No `node:` imports; safe to run
// in any JS runtime.
export type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicMessagesEntry,
  AnthropicTool,
  AnthropicUsage,
} from './trace/anthropic.js';
export {
  type AnthropicToGenAiInput,
  anthropicToGenAi,
} from './trace/genai.js';
export {
  type OpenAiResponsesToGenAiInput,
  openaiResponsesToGenAi,
} from './trace/openai-responses.js';
export {
  clearRegisteredSecretValues,
  containsRegisteredSecretValue,
  REDACTED,
  type RedactionOptions,
  redactHeaders,
  redactJson,
  redactSecrets,
  registerSecretValues,
} from './trace/redact.js';
export {
  looksLikeSseStream,
  parseSseEvents,
  reassembleAnthropicSse,
  type SseEvent,
} from './trace/sse.js';
export {
  type ParsedAnthropicMessage,
  parseAnthropicMessage,
  parseTranscriptLine,
  type TranscriptEntry,
} from './trace/transcript.js';

export { CORE_VERSION } from './version.js';
