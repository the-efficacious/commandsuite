/**
 * Loopback HTTP endpoint for Claude Code hook events.
 *
 * Claude Code's hook system fires lifecycle callbacks at points in the
 * agent loop we want presence for. We bind a small HTTP server here,
 * write its URL into `.claude/settings.json` as a `type: "http"` hook
 * target, and let Claude Code POST to us on each event. All events hit
 * the same URL; we route on `hook_event_name` in the payload.
 *
 * The hook server is PRESENCE-ONLY: it drives the ACTIVITY signal
 * (idle/working/blocked) and surfaces the transcript path. It no longer
 * emits `tool_action` / `user_prompt` CONTENT — the transcript reader is
 * the single source of that now (it carries the full, untruncated turn),
 * so hooks would only duplicate it. Every hook body carries a
 * `transcript_path`; we relay the first one we see (via `onTranscriptPath`)
 * so the capture host can start tailing the session transcript.
 *
 * Events we handle:
 *   - PreToolUse / PostToolUse / PostToolUseFailure — a tool-execution
 *     window. Bumps `tool_inflight` on Pre, decrements on Post. The tool
 *     CONTENT (input/result) comes from the transcript, not here.
 *   - UserPromptSubmit — TURN START. Opens a `turn_active` handle so the
 *     WHOLE turn (model generation + tools) reads as `working`, not just
 *     the tool windows.
 *   - Stop — TURN END. Finishes the turn's `turn_active` handle and
 *     clears `blocked`. (`stop_hook_active` = a blocking-loop retry, but
 *     it's still turn-ending for presence, so we treat it the same.)
 *   - SubagentStop — a subagent finished; the MAIN turn is still active
 *     until Stop, so this is informational (logged, no state change).
 *   - Notification — routes on `notification_type`: permission_prompt /
 *     agent_needs_input / elicitation_dialog → `blocked`; idle_prompt →
 *     not blocked; unknown types ignored.
 *   - SessionStart — relays `source` (startup / resume / clear /
 *     compact) via `onSessionStart`. The runner uses compact/clear as
 *     the "context fell off" signal to push a `context_refresh`
 *     re-brief. No presence effect.
 *
 * Why HTTP and not `type: "command"`:
 *   - Each `type: "command"` hook forks a process per event. With ~50
 *     tool calls per turn over a session, that's hundreds of Node
 *     startups for what should be a counter bump.
 *   - HTTP hooks are single localhost round-trips — sub-millisecond on
 *     loopback.
 *   - The runner already binds the IPC socket; a second loopback
 *     listener is cheap.
 *
 * Out-of-order / duplicate matching stays correct: a per-`tool_use_id`
 * map means PreToolUse for an id we already have is a no-op, PostToolUse
 * for an id we don't have is a no-op, and a double Post decrements at
 * most once. Turn handles are keyed the same way on `prompt_id` (falling
 * back to `session_id`) so a duplicate UserPromptSubmit can't
 * double-count a turn.
 *
 * On close, all outstanding handles (tool AND turn) are drained so a
 * torn-down runner can't leave the indicator wedged at "working".
 */

import { createServer, type Server } from 'node:http';
import type { ActivitySignal } from './busy.js';

export type ClaudeHookEventName =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'PostToolBatch'
  | 'UserPromptSubmit'
  | 'Stop'
  | 'SubagentStop'
  | 'Notification'
  | 'SessionStart';

interface HookRequestBody {
  hook_event_name?: string;
  tool_use_id?: string;
  /**
   * Absolute path to the session transcript JSONL. Present on every hook
   * body; the capture host tails it as the transcript-primary capture
   * source. We relay the first one we see via `onTranscriptPath`.
   */
  transcript_path?: string;
  /**
   * Correlation id bracketing one turn — UserPromptSubmit and its Stop
   * share it. Used as the turn-handle key (falls back to `session_id`).
   */
  prompt_id?: string;
  /** Session id; the turn-handle key fallback when `prompt_id` is absent. */
  session_id?: string;
  /**
   * On Notification: which kind of notice this is. We block on
   * permission_prompt / agent_needs_input / elicitation_dialog and
   * unblock on idle_prompt.
   */
  notification_type?: string;
  /**
   * On Stop: true when this fire is a blocking-loop retry (a Stop hook
   * that itself blocked). Still turn-ending for presence — recorded for
   * diagnostics only.
   */
  stop_hook_active?: boolean;
  /**
   * On SessionStart: why the session (re)started — `startup`, `resume`,
   * `clear`, or `compact`. Relayed via `onSessionStart`.
   */
  source?: string;
}

/**
 * Notification types that mean the agent is waiting on a human it can't
 * self-resolve. Any of these sets `blocked`.
 */
const BLOCKING_NOTIFICATION_TYPES: ReadonlySet<string> = new Set([
  'permission_prompt',
  'agent_needs_input',
  'elicitation_dialog',
]);

/**
 * Notification types that mean the agent is NOT blocked (it's sitting
 * idle waiting for the next prompt). Clears `blocked`.
 */
const UNBLOCKING_NOTIFICATION_TYPES: ReadonlySet<string> = new Set(['idle_prompt']);

export interface HookServer {
  /** The full URL that goes into the `type: "http"` hook config. */
  readonly url: string;
  /** Live count of outstanding tool handles. Useful for diagnostics. */
  readonly inFlight: number;
  /** Tear down: drain any remaining handles, close the listener. */
  close(): Promise<void>;
}

export interface HookServerOptions {
  busy: ActivitySignal;
  /**
   * Fired with the `transcript_path` from the first hook body that
   * carries one. The capture host wires this to start tailing the
   * session transcript (the transcript-primary capture source). Called
   * once per distinct path seen; the host dedups/pins internally.
   * Optional — when absent, the server drives presence only.
   */
  onTranscriptPath?: (path: string) => void;
  /**
   * Fired on every SessionStart hook with its `source` value
   * (`startup` / `resume` / `clear` / `compact`; empty string when the
   * payload omits it). The runner listens for compact/clear to push a
   * context re-brief. Optional.
   */
  onSessionStart?: (source: string) => void;
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
}

export async function startHookServer(options: HookServerOptions): Promise<HookServer> {
  const log =
    options.log ??
    ((msg: string, ctx: Record<string, unknown> = {}): void => {
      const record = { ts: new Date().toISOString(), component: 'hook-server', msg, ...ctx };
      process.stderr.write(`${JSON.stringify(record)}\n`);
    });

  // Per-tool-use-id handles. The same id appears in PreToolUse and
  // PostToolUse, so the matching is exact when Claude Code is
  // well-behaved. If we get an unexpected duplicate or out-of-order
  // event we err on the side of "do nothing surprising" rather than
  // double-bump or under-decrement.
  const handles = new Map<string, { finish: () => void }>();

  // Per-turn `turn_active` handles, keyed by prompt_id (falling back to
  // session_id). UserPromptSubmit opens one; the matching Stop closes
  // it. Keyed so a duplicate UserPromptSubmit can't double-count, and
  // so a Stop for a turn we never saw is a harmless no-op.
  const turnHandles = new Map<string, { finish: () => void }>();

  // The transcript path last relayed via `onTranscriptPath`. Deduped so
  // we fire the callback only on the first (and any changed) path rather
  // than on every hook body — every body carries it.
  let lastTranscriptPath: string | null = null;

  // Resolve the turn-handle key for a turn-lifecycle event. Prefer the
  // per-turn `prompt_id`; fall back to `session_id`; last-resort a
  // constant so a payload missing both ids still lights up `working`
  // (one turn per session means the constant can't collide across live
  // turns).
  const turnKey = (b: HookRequestBody): string => {
    if (typeof b.prompt_id === 'string' && b.prompt_id.length > 0) return b.prompt_id;
    if (typeof b.session_id === 'string' && b.session_id.length > 0) return b.session_id;
    return '__turn__';
  };

  const readBody = (req: NodeJS.ReadableStream): Promise<string> =>
    new Promise((resolve, reject) => {
      const parts: Buffer[] = [];
      let total = 0;
      // 64 KB is far more than any hook payload should be; cap to
      // defang slow-loris / oversized-body adversaries even on
      // loopback. A real claude payload is ~1-2 KB.
      const cap = 64 * 1024;
      req.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > cap) {
          req.removeAllListeners('data');
          req.removeAllListeners('end');
          reject(new Error('hook payload exceeded 64 KB cap'));
          return;
        }
        parts.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
      req.on('error', reject);
    });

  const server: Server = createServer(async (req, res) => {
    // Liveness only — anything except POST /hook/tool-event gets a 404
    // so misconfiguration is loud.
    if (req.method !== 'POST' || req.url !== '/hook/tool-event') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    let body: HookRequestBody;
    try {
      const raw = await readBody(req);
      const parsed = raw.length === 0 ? {} : JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('hook body is not a JSON object');
      }
      body = parsed as HookRequestBody;
    } catch (err) {
      log('hook-server: bad request', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad request' }));
      return;
    }

    // Relay the transcript path (present on every hook body) so the
    // capture host can tail it. Do this BEFORE routing on the event name
    // so even an event we don't act on still surfaces the path. Deduped
    // to the first distinct path — the host pins it, but this avoids a
    // callback per hook fire.
    if (
      typeof body.transcript_path === 'string' &&
      body.transcript_path.length > 0 &&
      body.transcript_path !== lastTranscriptPath
    ) {
      lastTranscriptPath = body.transcript_path;
      if (options.onTranscriptPath) {
        try {
          options.onTranscriptPath(body.transcript_path);
        } catch (err) {
          log('hook-server: onTranscriptPath threw', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    const event = body.hook_event_name;
    if (typeof event !== 'string' || event.length === 0) {
      // No event name — nothing to route on. Don't 4xx; Claude Code
      // might retry. 2xx no-op is safer.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ accepted: false, reason: 'missing hook_event_name' }));
      return;
    }

    const isToolEvent =
      event === 'PreToolUse' ||
      event === 'PostToolUse' ||
      event === 'PostToolUseFailure' ||
      event === 'PostToolBatch';

    if (isToolEvent) {
      const toolUseId = body.tool_use_id;
      if (typeof toolUseId !== 'string' || toolUseId.length === 0) {
        // Tool events without an id can't be matched. 2xx no-op rather
        // than 4xx so Claude Code doesn't retry-storm.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ accepted: false, reason: 'missing tool_use_id' }));
        return;
      }
      if (event === 'PreToolUse') {
        // Duplicate PreToolUse for the same id is a no-op — keep the
        // first handle so the matching Post still finds something.
        if (!handles.has(toolUseId)) {
          handles.set(toolUseId, options.busy.start('tool_inflight'));
        }
      } else {
        const handle = handles.get(toolUseId);
        if (handle) {
          handle.finish();
          handles.delete(toolUseId);
        }
        // Note: PostToolBatch may carry a synthetic batch id rather than
        // a real tool_use_id; we still try to drain the matching handle
        // in case Claude Code uses the same id space. Missing matches
        // are silent (no-op). The tool CONTENT (input/result) is NOT
        // emitted here — the transcript reader is the single source of
        // `tool_action` now, so a hook emission would only duplicate it.
      }
    } else if (event === 'UserPromptSubmit') {
      // TURN START — open a `turn_active` handle so the whole turn reads
      // as `working`. Keyed so a duplicate UserPromptSubmit is a no-op.
      // The opener CONTENT (`user_prompt`) comes from the transcript now,
      // not here — this is presence-only.
      const key = turnKey(body);
      if (!turnHandles.has(key)) {
        turnHandles.set(key, options.busy.start('turn_active'));
      }
    } else if (event === 'Stop') {
      // TURN END — clear any human-blocking state and close the turn's
      // `turn_active` handle. `stop_hook_active` means this is a
      // blocking-loop retry; still turn-ending for presence, so treat
      // it identically (recorded for diagnostics only).
      options.busy.setBlocked(false);
      const key = turnKey(body);
      const handle = turnHandles.get(key);
      if (handle) {
        handle.finish();
        turnHandles.delete(key);
      } else if (turnHandles.size > 0) {
        // Key mismatch (Stop carried a different id shape than the
        // opening UserPromptSubmit). One turn per session, so a Stop
        // ends every open turn — drain rather than leak until the
        // watchdog fires.
        log('hook-server: Stop with no key match, draining turn handles', {
          open: turnHandles.size,
        });
        for (const h of turnHandles.values()) h.finish();
        turnHandles.clear();
      }
    } else if (event === 'SubagentStop') {
      // A subagent finished; the MAIN turn is still active until Stop.
      // Informational only — no top-level state change.
      log('hook-server: subagent stop', { stopHookActive: body.stop_hook_active === true });
    } else if (event === 'Notification') {
      // Route on notification_type. Blocking types → the agent is
      // waiting on a human; idle_prompt → it isn't; unknown → ignore
      // (defensive: the smoke run never fired this, so novel types must
      // never wedge the signal).
      const nType = body.notification_type;
      if (typeof nType === 'string' && BLOCKING_NOTIFICATION_TYPES.has(nType)) {
        options.busy.setBlocked(true);
      } else if (typeof nType === 'string' && UNBLOCKING_NOTIFICATION_TYPES.has(nType)) {
        options.busy.setBlocked(false);
      }
    } else if (event === 'SessionStart') {
      // Session (re)start — no presence effect, but the `source` tells
      // the runner whether the agent's context just fell off (compact /
      // clear) and needs a re-brief.
      const source = typeof body.source === 'string' ? body.source : '';
      log('hook-server: session start', { source });
      if (options.onSessionStart) {
        try {
          options.onSessionStart(source);
        } catch (err) {
          log('hook-server: onSessionStart threw', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    // Any other event is accepted but drives nothing. We ignore it
    // politely so the user can share one hook config block across
    // events without worrying which we care about.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ accepted: true }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', (err) => reject(err));
    server.listen(0, '127.0.0.1');
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('hook-server: server.address() returned non-TCP binding');
  }
  const url = `http://127.0.0.1:${address.port}/hook/tool-event`;
  log('hook-server: listening', { url });

  return {
    url,
    get inFlight() {
      return handles.size;
    },
    async close(): Promise<void> {
      if (handles.size > 0 || turnHandles.size > 0) {
        log('hook-server: draining handles at close', {
          tools: handles.size,
          turns: turnHandles.size,
        });
        for (const handle of handles.values()) handle.finish();
        handles.clear();
        for (const handle of turnHandles.values()) handle.finish();
        turnHandles.clear();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
