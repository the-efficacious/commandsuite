/**
 * `csuite-core` — runtime-agnostic broker logic.
 *
 * Everything in here must be portable across JavaScript runtimes. No
 * `node:` imports, no fs, no http. Persistence/IO is injected via the
 * `EventLog` interface.
 */

export {
  ensureRetentionIndexes,
  type PruneActivityResult,
  pruneActivityDb,
} from './activity-retention.js';
export {
  type ActivityListener,
  type ActivityStore,
  clampListLimit,
  InMemoryActivityStore,
  type InMemoryActivityStoreOptions,
  type ListActivityFilter,
} from './activity-store.js';
export {
  type AppBindings,
  type AppOptions,
  type CreatedApp,
  composeSessionOnlineMessage,
  createApp,
  isApiPath,
} from './app.js';
export {
  type AuthBindings,
  type AuthDependencies,
  createAuthMiddleware,
} from './auth.js';
export {
  Broker,
  type BrokerOptions,
  CredentialShapedBodyError,
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
  type ChannelAuditEntry,
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
  type ApproveInput,
  DEFAULT_POLL_INTERVAL_S,
  ENROLLMENT_TTL_MS,
  type EnrollmentRow,
  type EnrollmentStatus,
  EnrollmentStore,
  type EnrollmentStoreOptions,
  formatUserCode,
  type Kek,
  type LookupOutcome,
  type MintInput,
  type MintResult,
  normalizeUserCode,
  type PollOutcome,
  type RejectInput,
} from './enrollments.js';
export {
  type EnvRival,
  type EnvRivalKind,
  ensureEnvNamespaceSchema,
  envRivalMessage,
  findEnvRivalAnyone,
  findEnvRivalForMember,
} from './env-namespace.js';
export {
  CHANNEL_THREAD_PREFIX,
  channelThreadTag,
  clampQueryLimit,
  DEFAULT_QUERY_LIMIT,
  type EventLog,
  type EventLogAppendOptions,
  type EventLogQueryOptions,
  type EventLogTailOptions,
  feedVisibleTo,
  GENERAL_CHANNEL_ID,
  InMemoryEventLog,
  isScopedThreadTag,
  isSecretThread,
  MAX_QUERY_LIMIT,
  OBJECTIVE_THREAD_PREFIX,
  SECRET_THREAD_PREFIX,
} from './event-log.js';
export {
  decryptFieldPortable,
  ENCRYPTED_FIELD_PREFIX,
  EncryptedFieldError,
  encryptFieldPortable,
  type FieldCipher,
  type GetFieldCipher,
} from './field-crypto.js';
export type {
  BlobStore,
  PutOptions,
  PutResult,
} from './files/blob-store.js';
export {
  FsError,
  type FsErrorCode,
} from './files/errors.js';
export {
  type CopyByBlobRefInput,
  createSqliteFilesystemStore,
  type FilesystemStore,
  type ObjectiveAclProvider,
  type ViewerContext,
  type WriteCollisionStrategy,
  type WriteFileInput,
  type WriteFileResult,
} from './files/filesystem-store.js';
export {
  basenameOf,
  dedupeBasename,
  isAncestorPath,
  joinPath,
  MAX_PATH_LENGTH,
  MAX_SEGMENT_LENGTH,
  normalizePath,
  OBJECTIVE_NAMESPACE_SEGMENT,
  OBJECTIVE_OWNER_PREFIX,
  objectiveNamespacePath,
  ownerOf,
  parentOf,
  parseObjectiveNamespacePath,
  ROOT_PATH,
  splitPath,
} from './files/paths.js';
export {
  EV_API_ERROR,
  EV_API_REQUEST,
  EV_API_REQUEST_BODY,
  EV_API_RESPONSE_BODY,
  GENAI_EVENT_NAMES,
  type GenAiCorrelator,
  type GenAiCorrelatorFactory,
  type GenAiCorrelatorOptions,
  isGenAiLogRecord,
  shortName,
} from './genai-capture.js';
export {
  createGenAiStore,
  type GenAiInferenceInput,
  type GenAiInferenceRow,
  type GenAiQuery,
  type GenAiStore,
  type GenAiStoreOptions,
} from './genai-store.js';
export { constantTimeEqual, sha256Hex } from './hashing.js';
export {
  type ComposeInstructionsInput,
  composedInstructionsSha256,
  composeInstructions,
  type InstructionBlock,
  type InstructionBlockKind,
  instructionBlocks,
  instructionCaptureExemptions,
} from './instructions.js';
export {
  createJwtVerifier,
  JwtClaimError,
  type JwtConfig,
  type JwtVerifier,
  looksLikeJwt,
  type VerifiedClaims,
} from './jwt.js';
export {
  type CreateLoggerOptions,
  createLogger,
  envLogLevel,
  LOG_LEVELS,
  type LogContext,
  type Logger,
  type LogLevel,
  type LogRecord,
  logger,
} from './logger.js';
export {
  createSqliteActivityStore,
  type SqliteActivityStoreHandle,
} from './member-activity.js';
export {
  type AddMemberInput,
  type LoadedMember,
  MemberLoadError,
  type MemberStore,
  resolvePermissions,
  teammatesFromMembers,
  type UpdateMemberPatch,
  validateMemberInstructions,
  validateMemberName,
  validatePermissionPreset,
  validateRawPermissions,
  validateRole,
  validateTeamContext,
  validateTeamName,
  validateTotpSecret,
} from './members-domain.js';
export {
  createNotificationDispatcher,
  type IngestInput,
  type IngestResult,
  type NotificationDispatcher,
  type NotificationDispatcherOptions,
} from './notifications/dispatcher.js';
export {
  applyFilters,
  type ComposeOptions,
  composeBody,
  defaultRender,
  type FilterResult,
  formatDuration,
  formatUtc,
  getPath,
  parsePayload,
  renderTemplate,
} from './notifications/render.js';
export {
  type CreateEndpointInput,
  createSqliteNotificationsStore,
  DEFAULT_POLICY,
  DELIVERY_RETENTION_PER_ENDPOINT,
  type DeliveryRecord,
  HOOK_BODY_MAX,
  type InsertDeliveryInput,
  NotificationsError,
  type NotificationsStore,
  type PendingRecord,
  type ResolvedVerification,
  toWireDelivery,
  type UpdateEndpointInput,
} from './notifications/store.js';
export {
  DEFAULT_HEADER_SECRET_HEADER,
  DEFAULT_HMAC_HEADER,
  DEFAULT_HMAC_PREFIX,
  type VerifyResult as InboundVerifyResult,
  verifyInbound,
} from './notifications/verify.js';
export {
  createSqliteObjectivesStore,
  ObjectivesError,
  type ObjectivesMutationResult,
  type ObjectivesStore,
} from './objectives.js';
export {
  anyValueToJs,
  flattenAttributes,
  parseOtlpLogs,
  parseOtlpMetrics,
} from './otlp-parse.js';
export {
  assertDocumentInvariants,
  createSqliteProcessDocumentStore,
  type EditableFields,
  ProcessDocumentError,
  type ProcessDocumentStore,
} from './process-document.js';
export {
  type DispatchDeps,
  dispatchPush,
  type PushPayload,
} from './push-dispatch.js';
export { shouldPush } from './push-policy.js';
export type {
  PushSender,
  PushSenderSubscription,
  PushSendOutcome,
} from './push-sender.js';
export {
  InMemoryPushSubscriptionStore,
  type InMemoryPushSubscriptionStoreOptions,
  type PushSubscriptionInput,
  type PushSubscriptionRow,
  type PushSubscriptionStore,
} from './push-subscription-store.js';
export { fromBase64Url, randomBase64Url, toBase64Url } from './random-id.js';
export type {
  AppendBodyInput,
  AppendBodyResult,
  RawBodyEnvelope,
  RawBodyQuery,
  RawBodyStats,
  RawBodyStore,
  RawExchangeRow,
} from './raw-body-types.js';
export {
  PresenceIdentityError,
  PresenceRegistry,
  type PresenceState,
  type Subscriber,
} from './registry.js';
export {
  createSqliteSecretsStore,
  SecretsError,
  type SecretsStore,
  validateEnvName,
} from './secrets.js';
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
export { runInTransaction } from './sql-driver.js';
export { SqliteEventLog } from './sqlite-event-log.js';
export { SqlitePushSubscriptionStore } from './sqlite-push-subscription-store.js';
export { SqliteSessionStore } from './sqlite-session-store.js';
export {
  createTokenStoreFromMembers,
  SqliteTokenStore,
  type TokenSeedMemberSource,
} from './sqlite-token-store.js';
export { type ComposeTeamStatusOptions, composeTeamStatus } from './team-status.js';
export {
  createSqliteMemberStore,
  openTeamAndMembers,
  TeamStore,
} from './team-store.js';
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
export {
  type ExecuteCustomToolInput,
  executeCustomTool,
  TOOL_RESULT_MAX_BYTES,
  type ToolCallResult,
} from './tool-sources/custom-executor.js';
export {
  type McpClientManagerOptions,
  type McpToolManager,
  McpUnavailableError,
} from './tool-sources/mcp-manager.js';
export {
  createSqliteToolSourceStore,
  type DecryptedCredential,
  type McpCachedTool,
  type ToolSourceStore,
  ToolSourcesError,
  validateSourceSlug,
} from './tool-sources/store.js';
export {
  BindingValidationError,
  type CustomToolBinding,
  DEFAULT_TIMEOUT_MS,
  type ExpandedRequest,
  expandBinding,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  staticOriginOf,
  TemplateError,
  validateBinding,
  walkResultPath,
} from './tool-sources/template.js';
export {
  currentCode,
  generateSecret,
  otpauthUri,
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
  TOTP_WINDOW,
  type VerifyResult,
  verifyCode,
} from './totp.js';
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
export {
  createSqliteVariablesStore,
  IDENTITY_ENV_NAMES,
  type IdentityMigrationResult,
  migrateIdentityToVariables,
  type VariablesStore,
  validateVariableSlug,
} from './variables.js';
export { CORE_VERSION } from './version.js';
export {
  createWorkStateTracker,
  WORK_STATE_TTL_MS,
  type WorkStateTracker,
} from './work-state.js';
