/**
 * `csuite-server` library entry.
 *
 * Exposes `runServer()` so the CLI can start the broker in-process
 * without spawning a subprocess. Keeps side effects minimal; the
 * caller owns signal handling and process.exit semantics.
 *
 * HTTPS modes:
 *   - off          → plain HTTP on `bindHttp` (default; localhost)
 *   - self-signed  → HTTP/2+TLS on `bindHttps` with a cert stored
 *                    under `<configDir>/certs/`. Optional HTTP→HTTPS
 *                    308 redirect listener on `bindHttp`.
 *   - custom       → HTTP/2+TLS with user-supplied cert/key paths
 *
 * HTTP/2 is the default transport because browsers cap HTTP/1.1 at
 * 6 concurrent connections per origin — users with many tabs open
 * would starve the 7th. HTTP/2 multiplexes requests over one
 * connection. WebSocket upgrades currently fall back to HTTP/1.1
 * via ALPN; `allowHTTP1: true` keeps that path working.
 */

import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { dirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { Broker, registerSecretValues } from 'csuite-core';
import { createApp } from './app.js';
import { createSqliteChannelStore } from './channels.js';
import { type DatabaseSyncInstance, openDatabase } from './db.js';
import { EnrollmentStore } from './enrollments.js';
import { createSqliteFilesystemStore, LocalBlobStore } from './files/index.js';
import { createGenAiStore, type GenAiStore } from './genai-store.js';
import { createHttp2ServerFactory } from './https/server.js';
import {
  HttpsConfigError,
  type LoadedCert,
  loadCustomCert,
  loadOrGenerateSelfSigned,
} from './https/store.js';
import { createJwtVerifier, type JwtConfig } from './jwt.js';
import { decryptField, ENCRYPTED_FIELD_PREFIX, encryptField } from './kek.js';
import { logger as defaultLogger, type Logger } from './logger.js';
import { type ActivityStore, createSqliteActivityStore } from './member-activity.js';
import {
  defaultHttpsConfig,
  getKek,
  type HttpsConfig,
  MemberLoadError,
  type MemberStore,
  type WebPushConfig,
} from './members.js';
import { createSqliteNotificationsStore } from './notifications/index.js';
import { createSqliteObjectivesStore } from './objectives.js';
import { dispatchPush } from './push/dispatch.js';
import { PushSubscriptionStore } from './push/store.js';
import { configureVapid, generateVapidKeys } from './push/vapid.js';
import { createRawBodyStore, type RawBodyStore } from './raw-body-store.js';
import { createSqliteSecretsStore } from './secrets.js';
import { updateServerConfigFile } from './server-config.js';
import { SessionStore } from './sessions.js';
import { SqliteEventLog } from './sqlite-event-log.js';
import { openTeamAndMembers, type TeamStore } from './team-store.js';
import { createTelemetryStore, type TelemetryStore } from './telemetry-store.js';
import { TokenStore } from './tokens.js';
import { createMcpClientManager, createSqliteToolSourceStore } from './tool-sources/index.js';
import { SERVER_VERSION } from './version.js';

export { composeBriefing } from './briefing.js';
export { type DatabaseSyncInstance, openDatabase } from './db.js';
export {
  DEFAULT_POLL_INTERVAL_S,
  ENROLLMENT_TTL_MS,
  EnrollmentStore,
  formatUserCode,
  normalizeUserCode,
} from './enrollments.js';
export {
  createGenAiCorrelator,
  type GenAiCorrelator,
  type GenAiCorrelatorOptions,
  isGenAiLogRecord,
} from './genai-correlator.js';
export {
  createGenAiStore,
  type GenAiInferenceInput,
  type GenAiInferenceRow,
  type GenAiQuery,
  type GenAiStore,
} from './genai-store.js';
export { HttpsConfigError, type LoadedCert } from './https/store.js';
export {
  createJwtVerifier,
  type JwtConfig,
  type JwtVerifier,
  looksLikeJwt,
  type VerifiedClaims,
} from './jwt.js';
export {
  ENCRYPTED_FIELD_PREFIX,
  EncryptedFieldError,
  KekResolutionError,
  resolveKek,
} from './kek.js';
export {
  type ActivityStore,
  createSqliteActivityStore,
  parseDurationMs,
  pruneActivityDb,
} from './member-activity.js';
export {
  type AddMemberInput,
  ConfigNotFoundError,
  defaultConfigPath,
  defaultHttpsConfig,
  generateMemberToken,
  type HttpsConfig,
  hashToken,
  type LoadedMember,
  MemberLoadError,
  type MemberStore,
  resolvePermissions,
  setKek,
  teammatesFromMembers,
  type UpdateMemberPatch,
  type WebPushConfig,
} from './members.js';
export {
  createNotificationDispatcher,
  createSqliteNotificationsStore,
  type NotificationDispatcher,
  NotificationsError,
  type NotificationsStore,
} from './notifications/index.js';
export {
  createSqliteObjectivesStore,
  ObjectivesError,
  type ObjectivesStore,
} from './objectives.js';
export {
  type AppendBodyInput,
  type AppendBodyResult,
  createRawBodyStore,
  type RawBodyEnvelope,
  type RawBodyQuery,
  type RawBodyStats,
  type RawBodyStore,
  type RawExchangeRow,
} from './raw-body-store.js';
export {
  createSqliteSecretsStore,
  SecretsError,
  type SecretsStore,
  validateEnvName,
} from './secrets.js';
export {
  loadServerConfigFromFile,
  resolveConfigPath,
  type ServerConfig,
  ServerConfigSchema,
  updateServerConfigFile,
  writeServerConfigFile,
} from './server-config.js';
export { SESSION_COOKIE_NAME, SESSION_TTL_MS, SessionStore } from './sessions.js';
export {
  createSqliteMemberStore,
  openTeamAndMembers,
  type TeamStore,
} from './team-store.js';
export {
  createTelemetryStore,
  type TelemetryQuery,
  type TelemetryRecord,
  type TelemetryRow,
  type TelemetryStore,
} from './telemetry-store.js';
export {
  generateBearerToken,
  hashRawToken,
  type InsertTokenInput,
  type InternalTokenRow,
  TOKEN_HASH_PREFIX,
  TokenStore,
} from './tokens.js';
export {
  currentCode as currentTotpCode,
  generateSecret as generateTotpSecret,
  otpauthUri,
  verifyCode as verifyTotpCode,
} from './totp.js';
export {
  createTtyWizardIO,
  type RunWizardOptions,
  runFirstRunWizard,
  type WizardIO,
} from './wizard.js';
export { SERVER_VERSION };

export interface RunServerOptions {
  /**
   * Team and members are sourced from the database (see team-store.ts).
   * `runServer` opens its own DB handle on `dbPath` and refuses to
   * boot if the team singleton row is missing — the caller (CLI entry
   * or wizard flow) is responsible for seeding the DB beforehand.
   */
  /**
   * HTTPS configuration. Omit or pass a mode:'off' config to run
   * plain HTTP. For self-signed mode the caller must also pass
   * `configDir` so we know where to persist the cert.
   */
  https?: HttpsConfig;
  /**
   * Existing VAPID credentials from the team config file. When
   * `null` or omitted AND `configPath` is set, runServer() will
   * auto-generate a fresh keypair and persist it back to the
   * config file. Set explicitly to skip Web Push entirely.
   */
  webPush?: WebPushConfig | null;
  /**
   * Federated-JWT configuration. When non-null, the auth middleware
   * verifies bearer tokens with JWT structure against the configured
   * issuer's JWKS. Null (or omitted) → the JWT path is dormant and
   * only opaque bearer tokens + session cookies authenticate. The
   * CLI entry point passes `TeamConfig.jwt` straight through; library
   * consumers can construct this programmatically.
   */
  jwt?: JwtConfig | null;
  /**
   * Path to the team config file — required only when auto-generating
   * VAPID keys on first boot, since we need to know where to write
   * the new `webPush` block. Loaders (`loadTeamConfigFromFile` +
   * the CLI entry) already know this path; lib consumers that
   * construct RunServerOptions by hand can pass it explicitly.
   */
  configPath?: string;
  /**
   * Directory to store cert files in when `https.mode === 'self-signed'`.
   * Required for self-signed mode, ignored otherwise. Typically
   * `dirname(configPath)` so certs sit next to the team config.
   */
  configDir?: string;
  /**
   * Absolute path to the built `csuite-web-host` bundle to serve as
   * the SPA. Defaults to `<dist>/../public` — i.e., `apps/server/public`
   * relative to the built `run.js`. Pass `null` to disable SPA
   * serving entirely (useful for tests and machine-only deployments).
   */
  publicRoot?: string | null;
  /**
   * Convenience override for the HTTP listener port. When provided
   * and `https.mode === 'off'`, this wins over `https.bindHttp`.
   * Ignored when HTTPS is active (configure ports via `https.bindHttp`
   * and `https.bindHttps` directly in that case). Primarily for
   * tests and the existing CLI env-var path.
   */
  port?: number;
  host?: string;
  dbPath?: string;
  /**
   * Pre-opened main DB. Used by test fixtures that seed team + members
   * before boot — `:memory:` SQLite handles aren't shared across opens,
   * so passing the seeded handle here is the only way to keep that
   * setup in scope. Production callers (CLI entry, library consumers)
   * pass `dbPath` and let runServer open its own.
   */
  db?: DatabaseSyncInstance;
  /**
   * Root directory for the content-addressed blob store backing
   * filesystem attachments. Defaults to `./data/files`. The path is
   * created if missing; blobs land under `<root>/<hash-prefix>/...`
   * with an atomic temp-and-rename upload flow.
   */
  filesRoot?: string;
  /**
   * Per-file upload cap in bytes. Defaults to 25 MB; the broker
   * additionally caps at 1 GB regardless of caller value.
   */
  maxFileSize?: number;
  /**
   * Dedicated SQLite file for the agent-activity (trace) store.
   *
   * Activity rows are the heaviest-write path in the broker — every
   * captured LLM exchange and tool action lands here,
   * batched at up to 50 events / 64 KB / 500 ms per active agent.
   * Running it on its own `DatabaseSyncInstance` keeps trace writes
   * from contending with the main broker DB's write lock (events,
   * objectives, sessions, push-subs). Dan's 2026-04-16 audit Part 5
   * flagged single-connection contention as the first real ceiling
   * we'd hit under load.
   *
   * Semantics:
   *   - Omitted + `dbPath === ':memory:'`   → `:memory:` (separate handle, fully isolated).
   *   - Omitted + `dbPath` is a file path  → `<dbPath>-activity.db` alongside the main DB.
   *   - Explicit `:memory:`                → separate in-memory DB.
   *   - Explicit file path                  → opened as-is.
   */
  activityDbPath?: string;
  logger?: Logger;
  /**
   * Optional callback once all listeners are bound. Fires once per
   * run with info about the primary (HTTPS if enabled, else HTTP)
   * listener.
   */
  onListen?: (info: ListenInfo) => void;
}

export interface ListenInfo {
  address: string;
  port: number;
  /** `http` or `https` — drives how the banner formats the URL. */
  protocol: 'http' | 'https';
  /** Populated for https modes. */
  cert?: LoadedCert;
  /** Port of the parallel HTTP→HTTPS redirect listener, if any. */
  redirectHttpPort?: number;
}

export interface RunningServer {
  stop: () => Promise<void>;
  /** Primary listener port — HTTPS when enabled, else HTTP. */
  port: number;
  host: string;
  protocol: 'http' | 'https';
}

/**
 * Resolve the default public dir. When `run.ts` is bundled to
 * `apps/server/dist/run.js`, `../public` points at `apps/server/public`
 * — the directory Vite builds the web package into. In dev (not
 * bundled) the same relative path resolves under `apps/server/src/`
 * which won't exist, and the static middleware will simply not
 * register its routes. That's the desired behavior: use Vite's dev
 * server on :5173 and proxy to the API instead.
 */
function defaultPublicRoot(): string {
  return pathResolve(dirname(fileURLToPath(import.meta.url)), '../public');
}

/**
 * Derive the default activity-DB path from the main DB path.
 *   - `:memory:`       → `:memory:` (separate in-memory DB).
 *   - `/path/foo.db`   → `/path/foo-activity.db`.
 *   - `/path/foo`      → `/path/foo-activity` (no extension case).
 * Keeps files next to the main DB so an operator who backs up one
 * directory backs up both.
 */
function defaultActivityDbPath(mainDbPath: string): string {
  if (mainDbPath === ':memory:') return ':memory:';
  const extIdx = mainDbPath.lastIndexOf('.');
  if (extIdx > mainDbPath.lastIndexOf('/') && extIdx !== -1) {
    return `${mainDbPath.slice(0, extIdx)}-activity${mainDbPath.slice(extIdx)}`;
  }
  return `${mainDbPath}-activity`;
}

export async function runServer(options: RunServerOptions): Promise<RunningServer> {
  const host = options.host ?? '127.0.0.1';
  const dbPath = options.dbPath ?? ':memory:';
  const log = options.logger ?? defaultLogger;
  // If the caller passed a top-level `port` and HTTPS is off, fold it
  // into the https block as bindHttp. Keeps the existing CLI + test
  // entry points working without threading a full https config.
  const httpsInput: HttpsConfig = options.https ?? defaultHttpsConfig();
  const https: HttpsConfig =
    options.port !== undefined && httpsInput.mode === 'off'
      ? { ...httpsInput, bindHttp: options.port }
      : httpsInput;

  // Open the main broker DB once and share it across modules for
  // event log / sessions / push-subs / objectives. `node:sqlite` is
  // single-connection-per-file; every module that writes to the
  // main DB gets a handle into the same underlying Database, not a
  // new connection.
  const db: DatabaseSyncInstance = options.db ?? openDatabase(dbPath);
  // Open the DB-backed team + member stores. Refuse to boot if no team
  // exists — the wizard or seeding caller must have populated it.
  const stores = openTeamAndMembers(db);
  if (!stores.team.hasTeam()) {
    if (options.db === undefined) db.close();
    throw new MemberLoadError(
      `runServer: no team in ${dbPath}. Run \`csuite serve\` to bootstrap, or seed via the API.`,
    );
  }
  const memberStore: MemberStore = stores.members;
  const teamStore: TeamStore = stores.team;

  const eventLog = new SqliteEventLog(db);
  const sessions = new SessionStore(db);
  const tokens = new TokenStore(db);

  // Pending-enrollment store for the device-code (`csuite connect`)
  // flow. KEK is the same one that wraps TOTP secrets and VAPID
  // keys at rest — pulled from `members.getKek()` (set earlier in
  // the entry point). Without a KEK the issued-token plaintext
  // sits in the DB cleartext for the brief window between approval
  // and the device's poll; the existing audit-completion path
  // (`apps/server/src/index.ts`) refuses to boot without a KEK so
  // production never hits that path.
  const enrollments = new EnrollmentStore(db, { kek: getKek() });
  const pushStore = new PushSubscriptionStore(db);
  const objectivesStore = createSqliteObjectivesStore(db);
  const channelStore = createSqliteChannelStore(db);
  // Tool-source registry — config-class, low write volume, main DB.
  const toolSourceStore = createSqliteToolSourceStore(db);
  // Secrets registry — config-class, KEK-encrypted values, main DB.
  // Register every stored value with the core trace redactor so
  // broker-side ingest (OTLP bodies, genai bundles) scrubs any secret
  // an agent echoed into its context. The app layer registers new
  // values as they're written; this covers pre-existing rows at boot.
  const secretsStore = createSqliteSecretsStore(db);
  // External Notifications registry — endpoints/profiles are
  // config-class; delivery receipts are bounded by the per-endpoint
  // ingress rate limit. Main DB.
  const notificationsStore = createSqliteNotificationsStore(db);
  try {
    registerSecretValues(secretsStore.allDecryptedValues());
  } catch (err) {
    log.warn('secret redaction registration failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  // MCP client manager for kind=mcp sources — lazy upstream
  // connections, closed on shutdown.
  const mcpManager = createMcpClientManager({
    store: toolSourceStore,
    version: SERVER_VERSION,
    logger: log,
  });

  // Activity store runs on its own `DatabaseSyncInstance` so trace
  // write pressure doesn't contend with the main broker's write
  // lock. See `activityDbPath` on RunServerOptions for the default-
  // derivation rules.
  const activityDbPath = options.activityDbPath ?? defaultActivityDbPath(dbPath);
  const activityDb: DatabaseSyncInstance = openDatabase(activityDbPath);
  const activityStore: ActivityStore = createSqliteActivityStore(activityDb, log);

  // Lossless OTLP telemetry sink. Shares the dedicated activity DB
  // handle — both are heavy-write, per-member operational streams we
  // keep off the main broker write lock — but is otherwise fully
  // independent (its own `telemetry` table, no shared append path).
  const telemetryStore: TelemetryStore = createTelemetryStore(activityDb, { logger: log });

  // Full-fidelity GenAI inference store. Shares the dedicated activity DB
  // handle (same heavy-write, off-the-main-lock rationale as the
  // telemetry sink) but is otherwise independent — its own
  // `gen_ai_inference` table, its own append path.
  const genaiStore: GenAiStore = createGenAiStore(activityDb, { logger: log });

  // Content-addressed raw-body store: the verbatim request/response
  // bytes UNDER the gen_ai derived view, captured before parse/redact.
  // Same activity-DB handle; the per-member correlators in app.ts do the
  // capture (and unlink the consumed spill files — the default).
  const rawBodyStore: RawBodyStore = createRawBodyStore(activityDb, { logger: log });

  // Virtual filesystem for file attachments. Blob store holds
  // content-addressed bytes on disk; the filesystem store holds path
  // tree + permissions + refcount metadata in the main SQLite.
  const filesRoot = options.filesRoot ?? './data/files';
  const blobStore = new LocalBlobStore(filesRoot);
  // Wire the objective-namespace ACL: the FS layer asks the
  // objectives store whether a given viewer is the originator,
  // assignee, or one of the watchers of an objective. The closure
  // hides the row shape so the FS package keeps no inbound
  // dependency on the objectives module beyond this seam.
  const filesStore = createSqliteFilesystemStore({
    db,
    blobs: blobStore,
    objectiveAcl: {
      isMember(objectiveId, viewerName) {
        const obj = objectivesStore.get(objectiveId);
        if (obj === null) return false;
        if (obj.originator === viewerName) return true;
        if (obj.assignee === viewerName) return true;
        return obj.watchers.includes(viewerName);
      },
    },
  });
  // Pre-seed home directories so browsers can list their own home
  // without having to write first.
  for (const s of memberStore.members()) {
    filesStore.ensureHome(s.name);
  }

  sessions.purgeExpired();
  enrollments.purgeExpired();
  tokens.purgeExpired();

  // VAPID lifecycle: keys come from the team config file (loaded by the
  // caller into `options.webPush`) or are freshly generated on first
  // boot. The private key is encrypted at rest with the KEK
  // (`enc-v1:...`), exactly like TOTP secrets — we decrypt it here for
  // in-memory signing and (re)persist it encrypted, transparently
  // migrating any legacy plaintext key. Skipping entirely is possible by
  // passing webPush: null AND omitting configPath — tests do this.
  const vapidKek = getKek();
  let webPush: WebPushConfig | null = options.webPush ?? null;
  let persistWebPush = false;
  if (webPush === null && options.configPath) {
    webPush = generateVapidKeys();
    persistWebPush = true;
  }
  if (webPush !== null) {
    // The stored private key is `enc-v1:...` (already encrypted), a
    // freshly-generated plaintext key, or a legacy plaintext key from
    // before at-rest encryption landed. `decryptField` passes non-`enc-v1`
    // values through unchanged, so this both decrypts and lets us detect
    // a key that still needs migrating. Without a KEK (test setups only —
    // `index.ts` refuses to boot without one) we treat the key as
    // plaintext, the same posture as before this change.
    const storedPrivateKey = webPush.vapidPrivateKey;
    const alreadyEncrypted = storedPrivateKey.startsWith(ENCRYPTED_FIELD_PREFIX);
    const privateKey =
      vapidKek !== null
        ? (decryptField(storedPrivateKey, vapidKek) ?? storedPrivateKey)
        : storedPrivateKey;
    // With a KEK, migrate any not-yet-encrypted key to `enc-v1` on disk.
    if (vapidKek !== null && !alreadyEncrypted) persistWebPush = true;
    if (persistWebPush && options.configPath) {
      // Encrypt at rest when a KEK is available; without one, fall back
      // to persisting as-is (the pre-encryption behavior).
      const persistedPrivateKey =
        vapidKek !== null ? (encryptField(privateKey, vapidKek) ?? storedPrivateKey) : privateKey;
      try {
        updateServerConfigFile(options.configPath, {
          webPush: { ...webPush, vapidPrivateKey: persistedPrivateKey },
        });
        log.info('VAPID keys persisted', {
          path: options.configPath,
          encrypted: vapidKek !== null,
        });
      } catch (err) {
        log.warn('failed to persist VAPID keys', {
          error: err instanceof Error ? err.message : String(err),
        });
        // Fall through — keys stay in memory for this run; next restart
        // retries persistence. Degrades gracefully rather than erroring.
      }
    }
    // web-push signs with the plaintext private key.
    configureVapid({ ...webPush, vapidPrivateKey: privateKey });
  }

  const broker = new Broker({
    eventLog,
    logger: {
      warn: (msg, ctx) => log.warn(msg, ctx),
      error: (msg, ctx) => log.error(msg, ctx),
    },
  });
  broker.seedMembers(memberStore.members());

  // Shutdown fan-out: when stop() is called, abort this controller;
  // every open WebSocket handler listens and closes its socket.
  // Without this, idle connections pin the HTTP server open and
  // Node's server.close() waits indefinitely.
  const shutdownController = new AbortController();

  // Load (or generate) TLS material up front so we can fail boot
  // early if the cert is unreadable.
  let cert: LoadedCert | null = null;
  if (https.mode === 'self-signed') {
    if (!options.configDir) {
      throw new HttpsConfigError(
        'runServer: https.mode = self-signed requires options.configDir to persist the cert',
      );
    }
    cert = await loadOrGenerateSelfSigned({
      configDir: options.configDir,
      lanIp: https.selfSigned.lanIp,
      validityDays: https.selfSigned.validityDays,
      regenerateIfExpiringWithin: https.selfSigned.regenerateIfExpiringWithin,
    });
  } else if (https.mode === 'custom') {
    if (!https.custom.certPath || !https.custom.keyPath) {
      throw new HttpsConfigError(
        'runServer: https.mode = custom requires both https.custom.certPath and https.custom.keyPath',
      );
    }
    cert = loadCustomCert({
      certPath: https.custom.certPath,
      keyPath: https.custom.keyPath,
    });
  }

  const secureCookies = https.mode !== 'off';
  // Explicit null = opt out. Undefined = use the computed default.
  const publicRoot =
    options.publicRoot === null ? undefined : (options.publicRoot ?? defaultPublicRoot());

  /**
   * Liveness lookup for the push policy — a name is "live" if
   * the broker registry reports at least one connected subscriber.
   * `broker.listPresences()` is a cheap snapshot; we call it once per
   * push dispatch (not per recipient) in practice, since dispatch
   * builds its own view.
   */
  const isLive = (name: string): boolean => {
    const agents = broker.listPresences();
    for (const a of agents) {
      if (a.name === name) return a.connected > 0;
    }
    return false;
  };

  // Push fanout hook: called by app.ts after every successful push,
  // runs the policy + dispatch path in the background. We use
  // `queueMicrotask` in app.ts, so this is already off the hot path
  // — just keep the handler itself cheap and catch errors.
  const onPushed = webPush
    ? (message: import('csuite-sdk/types').Message) => {
        void dispatchPush(message, {
          sessions: pushStore,
          members: memberStore,
          logger: log,
          isLive,
        }).catch((err) => {
          log.warn('push dispatch crashed', {
            messageId: message.id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    : undefined;

  // The DB-backed `MemberStore` persists every mutation transactionally
  // at the call site, so there is no longer a JSON-file rewrite step
  // to schedule. We pass an empty no-op into `createApp` to keep the
  // existing handler signature happy; it can be deleted from the
  // handler API in a follow-up cleanup pass.
  const persistMembers = (): void => {
    /* DB-backed members persist immediately; nothing to do. */
  };

  // Federated JWT verifier. Built once per run — the underlying JWKS
  // is cached internally by `jose` across verify calls, so key
  // rotation on the issuer side is picked up automatically on the
  // next unknown-kid it sees.
  const jwtVerifier = options.jwt ? createJwtVerifier(options.jwt) : undefined;

  const { app, injectWebSocket } = createApp({
    broker,
    members: memberStore,
    tokens,
    enrollments,
    sessions,
    teamStore,
    objectives: objectivesStore,
    channels: channelStore,
    toolSources: toolSourceStore,
    mcpManager,
    secrets: secretsStore,
    notifications: notificationsStore,
    activityStore: activityStore,
    telemetryStore: telemetryStore,
    genaiStore: genaiStore,
    rawBodyStore: rawBodyStore,
    files: filesStore,
    ...(options.maxFileSize !== undefined ? { maxFileSize: options.maxFileSize } : {}),
    ...(persistMembers !== undefined ? { persistMembers } : {}),
    version: SERVER_VERSION,
    logger: log,
    secureCookies,
    shutdownSignal: shutdownController.signal,
    ...(publicRoot !== undefined ? { publicRoot } : {}),
    ...(webPush !== null
      ? {
          pushStore,
          vapidPublicKey: webPush.vapidPublicKey,
        }
      : {}),
    ...(onPushed !== undefined ? { onPushed } : {}),
    ...(jwtVerifier !== undefined ? { jwt: jwtVerifier } : {}),
  });

  // Optional HTTP→HTTPS redirect listener. Only spun up when HTTPS
  // is active AND the user hasn't disabled it. Kept deliberately tiny
  // — no Hono, no middleware, just a 308 to the canonical https URL.
  let redirectServer: HttpServer | null = null;
  if (cert !== null && https.redirectHttpToHttps) {
    redirectServer = createHttpServer((req, res) => {
      const hostHeader = (req.headers.host ?? host).replace(/:\d+$/, '');
      const target = `https://${hostHeader}:${https.bindHttps}${req.url ?? '/'}`;
      res.writeHead(308, { Location: target });
      res.end();
    });
    // bind synchronously — a failure here is a hard config error (port in use)
    await new Promise<void>((resolve, reject) => {
      redirectServer?.once('error', reject);
      redirectServer?.listen(https.bindHttp, host, () => resolve());
    });
  }

  return new Promise<RunningServer>((resolve) => {
    const serveOptions: Parameters<typeof serve>[0] = {
      fetch: app.fetch,
      port: cert !== null ? https.bindHttps : https.bindHttp,
      hostname: host,
    };
    if (cert !== null) {
      const factory = createHttp2ServerFactory({ cert: cert.cert, key: cert.key });
      // @hono/node-server accepts `createServer` + `serverOptions`.
      // Type cast needed because ServeOptions is a union whose HTTP/2
      // branch isn't surfaced in the public type yet.
      (serveOptions as unknown as Record<string, unknown>).createServer = factory.createServer;
      (serveOptions as unknown as Record<string, unknown>).serverOptions = factory.serverOptions;
    }

    const server = serve(serveOptions, (info) => {
      // Keep-alive contract: the broker must never close an idle
      // keep-alive connection before the client's pool does, or a
      // client reusing a pooled socket races the server's close and
      // the request dies mid-flight (seen as hyper `IncompleteMessage`
      // from codex's OTLP exporter — the batch is then dropped, not
      // retried). The longest-lived known client pool is hyper's 90s
      // pool_idle_timeout, so hold idle sockets for 95s. headersTimeout
      // must exceed keepAliveTimeout or Node revives the same race.
      // HTTP/1 only — the HTTP/2 path (TLS) closes via GOAWAY and has
      // no such race.
      if (cert === null) {
        const httpServer = server as HttpServer;
        httpServer.keepAliveTimeout = 95_000;
        httpServer.headersTimeout = 100_000;
      }
      const protocol: 'http' | 'https' = cert !== null ? 'https' : 'http';
      const listenInfo: ListenInfo = {
        address: info.address,
        port: info.port,
        protocol,
      };
      // Wire WS upgrades into the Node HTTP server once it's up.
      // Must happen after `serve()` returns the server instance but
      // before any client can try to upgrade — the onListen callback
      // is the safe point.
      injectWebSocket(server);
      if (cert !== null) listenInfo.cert = cert;
      if (redirectServer !== null) {
        listenInfo.redirectHttpPort = https.bindHttp;
      }
      options.onListen?.(listenInfo);
      resolve({
        port: info.port,
        host: info.address,
        protocol,
        stop: () =>
          new Promise<void>((stopResolve) => {
            // Abort all live WebSocket connections first so close()
            // can complete.
            shutdownController.abort();
            const closeRedirect = () =>
              new Promise<void>((r) => {
                if (redirectServer === null) return r();
                redirectServer.close(() => r());
              });
            // Close upstream MCP clients (bounded — a hung upstream
            // must not wedge shutdown) before the DB goes away.
            const closeMcp = Promise.race([
              mcpManager.closeAll(),
              new Promise<void>((r) => setTimeout(r, 2_000).unref()),
            ]).catch(() => {});
            server.close(() => {
              void closeMcp
                .then(() => closeRedirect())
                .finally(() => {
                  void eventLog.close().finally(() => {
                    try {
                      db.close();
                    } catch (err) {
                      log.warn('db close failed', {
                        error: err instanceof Error ? err.message : String(err),
                      });
                    }
                    try {
                      activityDb.close();
                    } catch (err) {
                      log.warn('activity db close failed', {
                        error: err instanceof Error ? err.message : String(err),
                      });
                    }
                    stopResolve();
                  });
                });
            });
            // Best-effort: forcibly drop any remaining open sockets
            // after a short grace period in case a stream's cleanup
            // is slow. Node's `Server.closeAllConnections` is an
            // escape hatch; both main + redirect servers support it.
            setTimeout(() => {
              const maybeCloseAll = (server as unknown as { closeAllConnections?: () => void })
                .closeAllConnections;
              maybeCloseAll?.call(server);
              redirectServer?.closeAllConnections();
            }, 500).unref();
          }),
      });
    });
  });
}
