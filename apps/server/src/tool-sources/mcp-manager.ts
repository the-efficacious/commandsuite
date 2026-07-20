/**
 * MCP client manager contract for `kind=mcp` tool sources.
 *
 * The app layer talks to this interface; the concrete
 * `McpClientManager` (lazy single-flight connections over Streamable
 * HTTP, idle TTL, fingerprint-based staleness, retry-once on
 * connection-class errors) lives behind `createMcpClientManager`.
 * Tests substitute a fake implementing the same surface.
 */

import type { ToolSource } from 'csuite-sdk/types';
import type { ToolCallResult } from './custom-executor.js';
import type { McpCachedTool, ToolSourceStore } from './store.js';

/**
 * Upstream MCP server unreachable after the single reconnect retry.
 * The invoke route maps this to HTTP 502 — an admin-config problem,
 * not something the agent can self-correct (deliberate asymmetry
 * with custom tools, whose network failures are isError results).
 */
export class McpUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpUnavailableError';
  }
}

export interface McpToolManager {
  /** Relay a tools/call to the upstream server. */
  invoke(
    source: ToolSource,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<ToolCallResult>;
  /** Re-discover upstream tools and replace the DB cache. */
  refresh(source: ToolSource): Promise<{ tools: McpCachedTool[]; changed: boolean }>;
  /** Drop any live connection for a source (config/credential change, disable, delete). */
  invalidate(sourceId: string): void;
  /** Shutdown: close every live connection. */
  closeAll(): Promise<void>;
}

export interface McpClientManagerOptions {
  store: ToolSourceStore;
  version: string;
  logger: {
    warn(msg: string, ctx?: Record<string, unknown>): void;
    info(msg: string, ctx?: Record<string, unknown>): void;
  };
}

// The concrete `createMcpClientManager` lives in `mcp-client.ts`
// (added with the MCP slice) — the app layer depends only on the
// interface above so tests and custom-only deployments never load
// @modelcontextprotocol/sdk.
