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
  type PushContext,
  type RegistrationResult,
} from './broker.js';
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
  MAX_QUERY_LIMIT,
} from './event-log.js';
export {
  InMemoryPushSubscriptionStore,
  type InMemoryPushSubscriptionStoreOptions,
  type PushSubscriptionInput,
  type PushSubscriptionRow,
  type PushSubscriptionStore,
} from './push-subscription-store.js';
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
  REDACTED,
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
