/**
 * JSON-RPC 2.0 client for `codex app-server` over stdio.
 *
 * Wire format is one JSON object per line (see codex `transport/stdio.rs`).
 * No Content-Length framing — line breaks ARE the frame delimiter.
 * `readline.createInterface` handles partial-write reassembly for us.
 *
 * Surface:
 *
 *   - `request<R>(method, params)` — send a request, await the matching
 *     response. Rejects on JSON-RPC error or transport close.
 *   - `notify(method, params)` — fire-and-forget notification.
 *   - `onNotification(method, handler)` — subscribe to server-pushed
 *     notifications. Multiple subscribers per method allowed.
 *   - `onRequest(method, handler)` — handle a server-initiated request
 *     (codex → us). The handler returns a result or throws; we send
 *     the matching response. Used for the auto-approve fallbacks.
 *   - `close()` — drop pending requests with an explanatory error,
 *     stop reading stdin, end the writable stream.
 *
 * The client owns its own request-id counter (monotonic, starts at 1).
 * It does NOT own the stdin/stdout streams — the caller passes them in
 * and is responsible for spawning/teardown of the underlying process.
 * This keeps the JSON-RPC layer testable against a pair of in-memory
 * streams without spawning anything.
 */

import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

export class JsonRpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'JsonRpcError';
    this.code = code;
    this.data = data;
  }
}

export class JsonRpcClosedError extends Error {
  constructor(reason: string) {
    super(`json-rpc client closed: ${reason}`);
    this.name = 'JsonRpcClosedError';
  }
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcServerRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

export interface JsonRpcClientOptions {
  /** Client name reported in `initialize`. Defaults to `commandsuite-cli`. */
  clientName?: string;
  /** Client version reported in `initialize`. */
  clientVersion?: string;
  /**
   * Optional structured logger. JSON-RPC layer is normally silent; this
   * fires only for off-path events (parse errors, unmatched ids, etc.).
   */
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
}

export interface JsonRpcClient {
  request<R = unknown>(method: string, params?: unknown): Promise<R>;
  notify(method: string, params?: unknown): void;
  onNotification(method: string, handler: (params: unknown) => void): () => void;
  onRequest(method: string, handler: (params: unknown) => Promise<unknown> | unknown): () => void;
  /** Resolves when stdin closes (server exit) or `close()` is called. */
  readonly closed: Promise<void>;
  close(reason?: string): void;
}

export function createJsonRpcClient(
  stdout: Readable,
  stdin: Writable,
  options: JsonRpcClientOptions = {},
): JsonRpcClient {
  const log = options.log ?? (() => {});
  let nextId = 1;
  const pending = new Map<number, Pending>();
  const notificationHandlers = new Map<string, Set<(params: unknown) => void>>();
  const requestHandlers = new Map<string, (params: unknown) => Promise<unknown> | unknown>();

  let closedReason: string | null = null;
  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const writeMessage = (msg: unknown): void => {
    if (closedReason !== null) return;
    try {
      stdin.write(`${JSON.stringify(msg)}\n`);
    } catch (err) {
      log('json-rpc: write failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleResponse = (msg: JsonRpcResponse): void => {
    const idNum = typeof msg.id === 'number' ? msg.id : Number(msg.id);
    const handler = pending.get(idNum);
    if (!handler) {
      log('json-rpc: response for unknown id', { id: msg.id });
      return;
    }
    pending.delete(idNum);
    if (msg.error) {
      handler.reject(new JsonRpcError(msg.error.code, msg.error.message, msg.error.data));
    } else {
      handler.resolve(msg.result);
    }
  };

  const handleNotification = (msg: JsonRpcNotification): void => {
    const subs = notificationHandlers.get(msg.method);
    if (!subs || subs.size === 0) return;
    for (const sub of subs) {
      try {
        sub(msg.params);
      } catch (err) {
        log('json-rpc: notification handler threw', {
          method: msg.method,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };

  const handleServerRequest = (msg: JsonRpcServerRequest): void => {
    const handler = requestHandlers.get(msg.method);
    if (!handler) {
      // No handler — reply with method-not-found so codex doesn't hang.
      writeMessage({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `method not found: ${msg.method}` },
      });
      return;
    }
    Promise.resolve()
      .then(() => handler(msg.params))
      .then((result) => {
        writeMessage({ jsonrpc: '2.0', id: msg.id, result });
      })
      .catch((err: unknown) => {
        const code = err instanceof JsonRpcError ? err.code : -32603;
        const message = err instanceof Error ? err.message : String(err);
        writeMessage({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code, message },
        });
      });
  };

  const rl = createInterface({ input: stdout, crlfDelay: Infinity });
  rl.on('line', (line: string) => {
    if (line.length === 0) return;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      log('json-rpc: parse error', { line: line.slice(0, 200) });
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    const m = msg as { jsonrpc?: unknown; id?: unknown; method?: unknown };
    // Don't enforce `jsonrpc === '2.0'` on inbound: codex's wire types
    // (codex-rs/app-server-protocol/src/jsonrpc_lite.rs) deliberately
    // OMIT the `jsonrpc` field from JSONRPCRequest/Response/Notification/
    // Error structs, so every message it sends would fail a strict
    // version check. Route by shape instead — that's the discriminator
    // that actually carries information.
    const hasId = 'id' in m && m.id !== undefined && m.id !== null;
    if (typeof m.method === 'string') {
      // Has method → either a server request (with id) or a notification (no id).
      if (hasId) {
        handleServerRequest(msg as JsonRpcServerRequest);
      } else {
        handleNotification(msg as JsonRpcNotification);
      }
      return;
    }
    // No method → response (success or error). The handler tolerates
    // both `result` and `error` keys.
    if (hasId) {
      handleResponse(msg as JsonRpcResponse);
    }
  });

  const cleanup = (reason: string): void => {
    if (closedReason !== null) return;
    closedReason = reason;
    try {
      rl.close();
    } catch {
      /* ignore */
    }
    for (const [id, p] of pending.entries()) {
      p.reject(new JsonRpcClosedError(reason));
      pending.delete(id);
    }
    try {
      stdin.end();
    } catch {
      /* ignore */
    }
    resolveClosed();
  };

  rl.on('close', () => cleanup('stdout-closed'));
  stdout.on('error', (err) => {
    log('json-rpc: stdout error', {
      error: err instanceof Error ? err.message : String(err),
    });
    cleanup('stdout-error');
  });
  stdin.on('error', (err) => {
    log('json-rpc: stdin error', {
      error: err instanceof Error ? err.message : String(err),
    });
    cleanup('stdin-error');
  });

  return {
    request<R = unknown>(method: string, params?: unknown): Promise<R> {
      if (closedReason !== null) {
        return Promise.reject(new JsonRpcClosedError(closedReason));
      }
      const id = nextId++;
      return new Promise<R>((resolve, reject) => {
        pending.set(id, {
          resolve: (v) => resolve(v as R),
          reject,
        });
        writeMessage({ jsonrpc: '2.0', id, method, params });
      });
    },
    notify(method: string, params?: unknown): void {
      writeMessage({ jsonrpc: '2.0', method, params });
    },
    onNotification(method, handler) {
      let set = notificationHandlers.get(method);
      if (!set) {
        set = new Set();
        notificationHandlers.set(method, set);
      }
      set.add(handler);
      return () => {
        set?.delete(handler);
      };
    },
    onRequest(method, handler) {
      requestHandlers.set(method, handler);
      return () => {
        if (requestHandlers.get(method) === handler) {
          requestHandlers.delete(method);
        }
      };
    },
    closed,
    close(reason?: string) {
      cleanup(reason ?? 'closed-by-caller');
    },
  };
}
