/**
 * IPC protocol between the csuite runner (parent of the agent) and the
 * `csuite mcp-bridge` relay (child of the agent, spawned via .mcp.json).
 *
 * Wire format: newline-delimited JSON over a Unix domain socket. Each
 * frame is one JSON object terminated by `\n`. Max frame size is
 * capped at `MAX_FRAME_BYTES` — a runaway frame is a protocol error,
 * not a buffer-to-memory situation.
 *
 * Why newline-delimited JSON and not length-prefixed binary:
 *   - Protocol traffic is low-rate (a few frames per MCP call)
 *   - JSON is trivially debuggable with `socat` / `nc` if we ever
 *     need to poke at a live session
 *   - Node's `readline` handles framing out of the box on the receive
 *     side, and we never have to worry about partial frames
 *
 * Framing rules:
 *   - Every frame is a valid JSON object on a single line
 *   - No object value in any frame can contain a raw newline (MCP
 *     payloads are JSON themselves so this is naturally satisfied;
 *     we still defensively JSON.stringify with no indentation)
 *   - Frames larger than `MAX_FRAME_BYTES` are rejected by the
 *     receiver with an `error` frame reply
 *
 * All frames share a discriminator field `kind`. The message shapes
 * below exhaust every legal value.
 */

export const MAX_FRAME_BYTES = 1 * 1024 * 1024; // 1MB per frame

/**
 * Bridge → runner: "I received this MCP request from stdio, please
 * handle it and give me back the response." The `id` is the runner's
 * correlation id for matching the response; the bridge picks it (not
 * the MCP request id, which lives inside `params`).
 */
export interface IpcMcpRequest {
  kind: 'mcp_request';
  id: number;
  method: string;
  params: Record<string, unknown> | undefined;
}

/**
 * Runner → bridge: the response for a given `mcp_request`. The bridge
 * matches on `id` and forwards the result back to the MCP client.
 */
export interface IpcMcpResponse {
  kind: 'mcp_response';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Runner → bridge: "please emit this MCP notification to the client
 * on stdio." Used for channel events (inbound from SSE), the
 * runner's own `context_refresh` re-briefs, and `tools/list_changed`
 * — which fires only for genuine capability changes (tool-source
 * registry updates), never state freshness.
 */
export interface IpcMcpNotification {
  kind: 'mcp_notification';
  method: string;
  params: Record<string, unknown> | undefined;
}

/**
 * Either direction: "the connection is going away cleanly." The
 * counterpart should flush and close. This is a courtesy frame; a
 * dropped socket without a shutdown frame is also acceptable.
 */
export interface IpcShutdown {
  kind: 'shutdown';
  reason?: string;
}

/**
 * Either direction: "I received a malformed frame or an unexpected
 * condition." Informational — both sides still close the socket
 * afterward. The receiver of an `error` frame logs it and moves on.
 */
export interface IpcError {
  kind: 'error';
  message: string;
  /**
   * Correlation id for a request this error is a response to, if
   * applicable. Errors without a correlation id are connection-level.
   */
  id?: number;
}

export type IpcFrame = IpcMcpRequest | IpcMcpResponse | IpcMcpNotification | IpcShutdown | IpcError;

/**
 * Serialize a frame for wire transmission. Returns a Buffer with the
 * JSON + trailing newline. Throws if the encoded frame exceeds
 * `MAX_FRAME_BYTES` — callers should treat that as a programming
 * error (we shouldn't be building oversized frames) rather than a
 * wire-level issue.
 */
export function encodeFrame(frame: IpcFrame): Buffer {
  const line = `${JSON.stringify(frame)}\n`;
  const buf = Buffer.from(line, 'utf8');
  if (buf.byteLength > MAX_FRAME_BYTES) {
    throw new Error(`ipc: encoded frame ${buf.byteLength}B exceeds ${MAX_FRAME_BYTES}B limit`);
  }
  return buf;
}

/**
 * Parse a single line (no trailing newline) into a frame. Returns
 * null if the line is invalid JSON, not an object, or missing the
 * `kind` discriminator — callers log + drop invalid frames, since
 * the alternative is throwing and tearing down the whole connection
 * for one bad byte. Returns the parsed frame on success with no
 * deep shape validation; the caller routes on `.kind` and treats
 * any further shape mismatch as a handler-level error.
 */
export function parseFrame(line: string): IpcFrame | null {
  if (line.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const kind = (parsed as { kind?: unknown }).kind;
  if (typeof kind !== 'string') return null;
  switch (kind) {
    case 'mcp_request':
    case 'mcp_response':
    case 'mcp_notification':
    case 'shutdown':
    case 'error':
      return parsed as IpcFrame;
    default:
      return null;
  }
}

/**
 * Default socket path for the runner's IPC server. Uses a
 * process-specific subdirectory of `$TMPDIR` (or `/tmp`) so multiple
 * runners can coexist on one host without clobbering each other's
 * sockets. The caller owns cleanup — typically the runner `unlink`s
 * the socket on shutdown.
 */
export function defaultSocketPath(pid: number = process.pid): string {
  const tmp = process.env.TMPDIR ?? '/tmp';
  return `${tmp}/.csuite-runner-${pid}.sock`;
}

/**
 * Env var the runner sets on the agent child so the bridge
 * (spawned by the agent as an MCP server) can find the socket.
 * A bridge started without this env var is a configuration error
 * and will exit immediately with a clear message.
 */
export const RUNNER_SOCKET_ENV = 'CSUITE_RUNNER_SOCKET';
