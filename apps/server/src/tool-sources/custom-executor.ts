/**
 * Custom tool executor — expands a validated binding against the
 * caller's args, injects the source credential, performs the HTTP
 * request with native fetch, and maps the response into an
 * MCP-shaped CallToolResult.
 *
 * Failure taxonomy (all returned as `isError: true` RESULTS, never
 * thrown — MCP convention is that tool failures are successful calls
 * with error payloads the model can read and self-correct on):
 *   - template errors (missing/ill-typed args, origin drift)
 *   - upstream non-2xx (status + capped body — error bodies are
 *     diagnostic gold)
 *   - network errors (DNS, refused, TLS)
 *   - timeouts
 *
 * Only broker-side registry corruption throws (the route maps it to
 * a 500): that never happens in this module — corrupt bindings and
 * credential decrypt failures surface before we're called.
 *
 * Response caps: the raw body is STREAM-read up to
 * TOOL_RESULT_MAX_BYTES and the reader cancelled past the cap — a
 * multi-GB upstream response never buffers. The truncation marker is
 * appended AFTER capping so it is always visible.
 */

import type { DecryptedCredential } from './store.js';
import {
  type CustomToolBinding,
  expandBinding,
  TemplateError,
  walkResultPath,
} from './template.js';

export const TOOL_RESULT_MAX_BYTES = 65_536;
const TRUNCATION_MARKER = (cap: number): string => `\n[csuite: response truncated at ${cap} bytes]`;

/**
 * MCP CallToolResult shape (structural — kept SDK-free so custom-only
 * deployments never load @modelcontextprotocol/sdk). The custom
 * executor only produces text blocks; the MCP relay may pass through
 * image/resource blocks and structuredContent.
 */
export interface ToolCallResult {
  content: Array<Record<string, unknown>>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

function textResult(text: string): ToolCallResult {
  return { content: [{ type: 'text', text }] };
}

function errorResult(text: string): ToolCallResult {
  return { content: [{ type: 'text', text }], isError: true };
}

export interface ExecuteCustomToolInput {
  binding: CustomToolBinding;
  credential: DecryptedCredential | null;
  args: Record<string, unknown>;
  /** Test seam — defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

export async function executeCustomTool(input: ExecuteCustomToolInput): Promise<ToolCallResult> {
  // 1. Template expansion — all failures happen before any I/O.
  let expanded: ReturnType<typeof expandBinding>;
  try {
    expanded = expandBinding(input.binding, input.args);
  } catch (err) {
    if (err instanceof TemplateError) return errorResult(err.message);
    throw err;
  }

  // 2. Credential injection, post-expansion. Unconditionally
  //    overwrites any same-named header — the save-time guard already
  //    rejects such bindings, but the executor doesn't rely on that.
  const headers = new Headers(expanded.headers);
  if (expanded.contentType !== null) headers.set('Content-Type', expanded.contentType);
  if (input.credential !== null) {
    if (input.credential.kind === 'bearer') {
      headers.set('Authorization', `Bearer ${input.credential.secret}`);
    } else if (input.credential.headerName) {
      headers.set(input.credential.headerName, input.credential.secret);
    }
  }

  // 3. Request. `redirect: 'follow'` — undici strips Authorization on
  //    cross-origin redirects, which is the safe default; we don't
  //    re-attach.
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  let res: Response;
  try {
    res = await fetchImpl(expanded.url, {
      method: input.binding.method,
      headers,
      body: expanded.body,
      signal: AbortSignal.timeout(expanded.timeoutMs),
      redirect: 'follow',
    });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      return errorResult(`upstream request timed out after ${expanded.timeoutMs}ms`);
    }
    // Never serialize the request object into the error path — a
    // fetch rejection message carries no headers, so this is safe.
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(`upstream request failed: ${msg}`);
  }

  // 4. Capped stream-read of the body.
  const { text: rawText, truncated } = await readBodyCapped(res, TOOL_RESULT_MAX_BYTES);
  const mime = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const isJson = mime === 'application/json' || mime.endsWith('+json');
  const isTextLike = isJson || mime.startsWith('text/') || mime === '';

  if (!res.ok) {
    const detail = isTextLike && rawText.length > 0 ? `\n${rawText}` : '';
    return errorResult(
      `upstream returned HTTP ${res.status} ${res.statusText}${detail}${
        truncated ? TRUNCATION_MARKER(TOOL_RESULT_MAX_BYTES) : ''
      }`,
    );
  }

  if (!isTextLike) {
    return textResult(`[binary response: ${mime}, ${rawText.length} bytes — not relayed]`);
  }

  if (res.status === 204 || rawText.length === 0) {
    return textResult(`[no content — HTTP ${res.status}]`);
  }

  // 5. JSON handling + resultPath extraction. A parse failure on a
  //    JSON-labelled body passes the raw text through — not an error.
  let text = rawText;
  if (isJson && !truncated) {
    try {
      const parsed: unknown = JSON.parse(rawText);
      if (input.binding.resultPath) {
        const extracted = walkResultPath(parsed, input.binding.resultPath);
        if (extracted === undefined) {
          text = `[resultPath '${input.binding.resultPath}' did not match; returning full response]\n${rawText}`;
        } else {
          text = typeof extracted === 'string' ? extracted : JSON.stringify(extracted, null, 2);
        }
      }
    } catch {
      /* unparseable "JSON" — relay raw text */
    }
  }

  // Re-cap after extraction (resultPath can only shrink, but the
  // notice-prefixed fallback can exceed the cap by the notice length).
  let finalTruncated = truncated;
  if (byteLength(text) > TOOL_RESULT_MAX_BYTES) {
    text = truncateToBytes(text, TOOL_RESULT_MAX_BYTES);
    finalTruncated = true;
  }
  if (finalTruncated) text += TRUNCATION_MARKER(TOOL_RESULT_MAX_BYTES);
  return textResult(text);
}

/**
 * Stream-read a response body up to `cap` bytes, cancelling the
 * reader past the cap. Decodes UTF-8 lossily.
 */
async function readBodyCapped(
  res: Response,
  cap: number,
): Promise<{ text: string; truncated: boolean }> {
  const body = res.body;
  if (body === null) return { text: '', truncated: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      if (total + value.length > cap) {
        chunks.push(value.subarray(0, cap - total));
        total = cap;
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
      total += value.length;
    }
  } catch {
    // Mid-stream failure: return what we have; the status line already
    // told the caller whether the request itself succeeded.
    truncated = true;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return { text: new TextDecoder('utf-8', { fatal: false }).decode(merged), truncated };
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

function truncateToBytes(s: string, cap: number): string {
  const bytes = new TextEncoder().encode(s);
  if (bytes.length <= cap) return s;
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, cap));
}
