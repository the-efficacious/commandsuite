/**
 * Concrete MCP client manager for `kind=mcp` tool sources.
 *
 * One lazily-connected, single-flight `Client` per source over
 * Streamable HTTP, shared across member invokes (the SDK protocol
 * layer multiplexes concurrent requests by JSON-RPC id, and the
 * transport issues each send as its own POST — no cross-request
 * state to corrupt). Static credentials ride on every request via
 * the transport's `requestInit` headers.
 *
 * Lifecycle rules:
 *   - Lazy connect on first use; concurrent callers await the same
 *     single-flight `ready` promise; a rejected connect deletes the
 *     entry so the next call retries fresh.
 *   - Sliding 5-minute idle TTL per entry (timers `.unref()`'d so
 *     they never pin the process).
 *   - Staleness: a fingerprint of (url, credential updatedAt) is
 *     checked on every acquire; mutation endpoints also call
 *     `invalidate()` explicitly. Either path drops the connection so
 *     the next use reconnects with fresh config.
 *   - Retry ONCE on connection-class errors (transport closed,
 *     network failure) — never on timeouts or MCP protocol errors,
 *     where the call may have executed upstream.
 *   - `closeAll()` on server shutdown.
 *
 * Error mapping (matches the invoke route's taxonomy):
 *   - `McpError` from the upstream (unknown tool, invalid params,
 *     timeout −32001) → 200 + `isError: true` results the model can
 *     read and self-correct on.
 *   - Connection failure after the single retry → `McpUnavailableError`
 *     → HTTP 502 (admin-config problem, not agent-correctable).
 */

import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { ToolSource } from 'csuite-sdk/types';
import { TOOL_RESULT_MAX_BYTES, type ToolCallResult } from './custom-executor.js';
import type { McpClientManagerOptions, McpToolManager } from './mcp-manager.js';
import { McpUnavailableError } from './mcp-manager.js';
import type { McpCachedTool } from './store.js';

const IDLE_TTL_MS = 5 * 60_000;
const CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const MAX_TOTAL_TIMEOUT_MS = 120_000;
const LIST_TIMEOUT_MS = 30_000;
/** Total serialized relay cap — oversized non-text blocks get replaced. */
const RELAY_TOTAL_MAX_BYTES = 256 * 1024;

interface ManagedEntry {
  client: Client;
  transport: StreamableHTTPClientTransport;
  ready: Promise<void>;
  fingerprint: string;
  idleTimer: NodeJS.Timeout | null;
}

class McpClientManager implements McpToolManager {
  private readonly entries = new Map<string, ManagedEntry>();
  private closed = false;

  constructor(private readonly deps: McpClientManagerOptions) {}

  private fingerprintOf(source: ToolSource): string {
    const credUpdatedAt = this.deps.store.credentialUpdatedAt(source.id);
    return createHash('sha256')
      .update(`${source.config.url ?? ''}|${credUpdatedAt}`)
      .digest('hex');
  }

  private credentialHeaders(source: ToolSource): Record<string, string> {
    const cred = this.deps.store.getCredential(source.id);
    if (cred === null) return {};
    if (cred.kind === 'bearer') return { Authorization: `Bearer ${cred.secret}` };
    if (cred.headerName) return { [cred.headerName]: cred.secret };
    return {};
  }

  /**
   * Get (or create) the live entry for a source. Inserts the entry —
   * with its in-flight `ready` promise — synchronously, so concurrent
   * acquires share one connect instead of racing.
   */
  private acquire(source: ToolSource): ManagedEntry {
    if (this.closed) {
      throw new McpUnavailableError('broker is shutting down');
    }
    const fingerprint = this.fingerprintOf(source);
    const existing = this.entries.get(source.id);
    if (existing) {
      if (existing.fingerprint === fingerprint) {
        this.touch(source.id, existing);
        return existing;
      }
      // Config or credential changed under a live connection.
      this.invalidate(source.id);
    }

    const url = source.config.url;
    if (!url) {
      throw new McpUnavailableError('source has no upstream URL configured');
    }
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: this.credentialHeaders(source) },
    });
    const client = new Client(
      { name: 'csuite-broker', version: this.deps.version },
      { capabilities: {} },
    );
    const entry: ManagedEntry = {
      client,
      transport,
      fingerprint,
      idleTimer: null,
      ready: client.connect(transport, { timeout: CONNECT_TIMEOUT_MS }).catch((err) => {
        // Failed connect: drop the entry so the next call retries
        // fresh, then rethrow to every awaiting caller.
        if (this.entries.get(source.id) === entry) this.entries.delete(source.id);
        throw err;
      }),
    };
    // A transport that dies later must not serve stale sends.
    transport.onclose = () => {
      if (this.entries.get(source.id) === entry) this.entries.delete(source.id);
    };
    transport.onerror = (err) => {
      this.deps.logger.warn('mcp transport error', {
        source: source.slug,
        error: err instanceof Error ? err.message : String(err),
      });
    };
    this.entries.set(source.id, entry);
    this.touch(source.id, entry);
    return entry;
  }

  private touch(sourceId: string, entry: ManagedEntry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      if (this.entries.get(sourceId) === entry) {
        this.entries.delete(sourceId);
        void closeEntry(entry);
      }
    }, IDLE_TTL_MS);
    entry.idleTimer.unref?.();
  }

  invalidate(sourceId: string): void {
    const entry = this.entries.get(sourceId);
    if (!entry) return;
    this.entries.delete(sourceId);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    void closeEntry(entry);
  }

  async closeAll(): Promise<void> {
    this.closed = true;
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
    }
    await Promise.allSettled(entries.map((e) => closeEntry(e)));
  }

  async invoke(
    source: ToolSource,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<ToolCallResult> {
    const timeout = clampTimeout(source.config.timeoutMs);
    const attempt = async (): Promise<ToolCallResult> => {
      const entry = this.acquire(source);
      await entry.ready;
      const result = (await entry.client.callTool({ name: toolName, arguments: args }, undefined, {
        timeout,
        resetTimeoutOnProgress: true,
        maxTotalTimeout: MAX_TOTAL_TIMEOUT_MS,
      })) as CallToolResult;
      return sanitizeResult(result);
    };

    try {
      return await attempt();
    } catch (err) {
      if (err instanceof McpError) {
        // Protocol-level upstream failure — the model can read it.
        // Never retry: the call may have executed.
        return mcpErrorResult(err, toolName);
      }
      // Connection-class: invalidate and retry exactly once.
      this.invalidate(source.id);
      this.deps.logger.warn('mcp invoke connection error — retrying once', {
        source: source.slug,
        tool: toolName,
        error: err instanceof Error ? err.message : String(err),
      });
      try {
        return await attempt();
      } catch (retryErr) {
        if (retryErr instanceof McpError) return mcpErrorResult(retryErr, toolName);
        this.invalidate(source.id);
        throw new McpUnavailableError(
          retryErr instanceof Error ? retryErr.message : String(retryErr),
        );
      }
    }
  }

  async refresh(source: ToolSource): Promise<{ tools: McpCachedTool[]; changed: boolean }> {
    const listAll = async (): Promise<McpCachedTool[]> => {
      const entry = this.acquire(source);
      await entry.ready;
      const tools: McpCachedTool[] = [];
      let cursor: string | undefined;
      do {
        const page = await entry.client.listTools(cursor ? { cursor } : undefined, {
          timeout: LIST_TIMEOUT_MS,
        });
        for (const t of page.tools) {
          tools.push({
            name: t.name,
            description: t.description ?? '',
            inputSchema: (t.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
            annotations: t.annotations ? (t.annotations as Record<string, unknown>) : null,
          });
        }
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return tools;
    };

    let tools: McpCachedTool[];
    try {
      tools = await listAll();
    } catch (err) {
      // One reconnect retry for connection-class failures, mirroring
      // invoke. McpError here means the upstream is alive but unhappy
      // — surface it as unavailable too; refresh has no isError lane.
      this.invalidate(source.id);
      try {
        tools = await listAll();
      } catch (retryErr) {
        this.invalidate(source.id);
        throw new McpUnavailableError(
          retryErr instanceof Error ? retryErr.message : String(retryErr),
        );
      }
    }
    const { changed } = this.deps.store.replaceMcpToolsCache(source.id, tools);
    return { tools, changed };
  }
}

function clampTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return DEFAULT_CALL_TIMEOUT_MS;
  return Math.min(Math.max(timeoutMs, 1_000), MAX_TOTAL_TIMEOUT_MS);
}

async function closeEntry(entry: ManagedEntry): Promise<void> {
  try {
    await entry.transport.terminateSession();
  } catch {
    /* best-effort — stateless upstreams 405 this */
  }
  try {
    await entry.client.close();
  } catch {
    /* best-effort */
  }
}

function mcpErrorResult(err: McpError, toolName: string): ToolCallResult {
  if (err.code === ErrorCode.RequestTimeout) {
    return {
      content: [{ type: 'text', text: `upstream tool call timed out: ${toolName}` }],
      isError: true,
    };
  }
  const hint =
    err.code === ErrorCode.MethodNotFound || err.code === ErrorCode.InvalidParams
      ? ' (if the upstream toolset changed, ask an operator to refresh the source)'
      : '';
  return {
    content: [{ type: 'text', text: `upstream MCP error ${err.code}: ${err.message}${hint}` }],
    isError: true,
  };
}

/**
 * Pass upstream content through with caps: text blocks trimmed to
 * TOOL_RESULT_MAX_BYTES each, and non-text blocks replaced with a
 * placeholder when the total serialized result would exceed the
 * relay cap (a giant base64 image should not ride the runner IPC).
 */
function sanitizeResult(result: CallToolResult): ToolCallResult {
  const marker = `\n[csuite: response truncated at ${TOOL_RESULT_MAX_BYTES} bytes]`;
  const content: Array<{ type: 'text'; text: string } & Record<string, unknown>> = [];
  let budget = RELAY_TOTAL_MAX_BYTES;
  for (const block of Array.isArray(result.content) ? result.content : []) {
    if (block.type === 'text' && typeof block.text === 'string') {
      let text = block.text;
      const bytes = Buffer.byteLength(text, 'utf8');
      if (bytes > TOOL_RESULT_MAX_BYTES) {
        text =
          Buffer.from(text, 'utf8').subarray(0, TOOL_RESULT_MAX_BYTES).toString('utf8') + marker;
      }
      budget -= Buffer.byteLength(text, 'utf8');
      content.push({ ...block, type: 'text', text });
      continue;
    }
    const serialized = JSON.stringify(block);
    if (serialized.length > budget) {
      content.push({
        type: 'text',
        text: `[${String(block.type)} block omitted: ${serialized.length} bytes exceeds relay cap]`,
      });
      continue;
    }
    budget -= serialized.length;
    // Non-text blocks (image/audio/resource) pass through untouched.
    content.push(block as never);
  }
  return {
    content: content as ToolCallResult['content'],
    ...(result.isError === true ? { isError: true } : {}),
    ...(result.structuredContent !== undefined
      ? { structuredContent: result.structuredContent }
      : {}),
  } as ToolCallResult;
}

export function createMcpClientManager(deps: McpClientManagerOptions): McpToolManager {
  return new McpClientManager(deps);
}
