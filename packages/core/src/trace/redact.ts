/**
 * Secret redaction for captured activity.
 *
 * NOTHING HERE SEES NETWORK TRAFFIC. Capture is fed by each agent's
 * own instrumentation — Claude Code's session transcript, codex's
 * rollout JSONL — so what passes through is already-parsed content,
 * never intercepted HTTP (see `cli/runtime/trace/host.ts`).
 *
 * The threat model: secrets surface inside CONTENT. An agent runs
 * `env`, echoes a token into a tool result, or pastes a key into a
 * request body. Before any of that leaves the runner (uploaded to
 * the csuite server, shown in a web UI, or written to disk), we scrub
 * known-bad patterns in place.
 *
 * WHAT IS NOT REDACTED, and it matters: the raw request/response body
 * store keeps bytes VERBATIM, deliberately, captured before anything
 * parses or redacts them — that is what makes byte-exact
 * reconstruction possible. See `server/src/raw-body-store.ts`. This
 * module protects the normalized activity stream and the parsed
 * `gen_ai_inference` records, not the raw blobs.
 *
 * Redaction philosophy:
 *   - Header-level: strip Authorization, x-api-key, cookie, set-cookie,
 *     proxy-authorization, x-anthropic-api-key entirely — replace the
 *     VALUE with `[REDACTED]` and keep the header name so structural
 *     analysis still works.
 *     NOTE: `redactHeaders` is a published export of `csuite-core` with
 *     NO in-tree caller. It exists for consumers that do hold raw
 *     headers; nothing in this repo captures raw headers. Kept rather
 *     than removed because it is public API — but do not read its
 *     presence as evidence that csuite inspects HTTP headers.
 *   - Body-level: pattern-match common key shapes (Anthropic `sk-ant-…`,
 *     OpenAI `sk-…`, AWS `AKIA…`, GitHub `ghp_…`, slack `xox…`) and
 *     replace the matched substring with `[REDACTED]`.
 *   - Content IS scrubbed, and this is the sentence to get right.
 *     `redactJson` walks every string leaf, and the production mappers
 *     call it directly on message text, tool arguments, tool results,
 *     reasoning and model completions (`genai.ts`,
 *     `openai-responses.ts`, `transcript.ts`, and codex's
 *     `rollout-parser.ts`). A matching pattern or a registered literal
 *     inside a tool result is replaced there, same as anywhere else.
 *     What is preserved is content STRUCTURE and everything that does
 *     not match: we never drop a message, a block, or a field, and we
 *     never redact on suspicion of sensitivity — only on an exact
 *     pattern or an exactly-registered value. So "the trace keeps the
 *     content" is true; "the trace never rewrites content" is false.
 *   - Value-level: literal secret values registered at runtime (the
 *     broker-held secrets a runner injects into the agent's
 *     environment) are scrubbed from every string that passes
 *     through, wherever they appear. Unlike the pattern list this
 *     catches arbitrary values with no recognizable shape — an agent
 *     that runs `env` or `echo $MY_SECRET` leaks the value into tool
 *     results, and the registered literal is what catches it before
 *     upload.
 */

const HEADERS_TO_STRIP: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'x-anthropic-api-key',
  'cookie',
  'set-cookie',
]);

const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
];

export const REDACTED = '[REDACTED]';

export interface RedactionOptions {
  /**
   * Exact broker-composed instruction substrings that must survive capture.
   * Exemptions are scoped to the call; they are never registered globally.
   */
  exemptions?: readonly string[];
}

/**
 * Values shorter than this are never registered — scrubbing very
 * short literals ("dev", "1234") would shred ordinary trace content
 * far more often than it would catch a real secret.
 */
const MIN_REGISTERED_VALUE_LENGTH = 6;

/**
 * Literal secret values to scrub from every string, longest first so
 * a value that contains another registered value redacts cleanly.
 * Module-global by design (same precedent as the server's KEK
 * holder): one process serves one member, and the runner registers
 * its resolved secret values once at startup, before any capture
 * begins.
 */
let registeredValues: string[] = [];

/**
 * Register literal secret values for redaction. Each value is
 * scrubbed both verbatim and in its URL-encoded form (query-param
 * leaks are common). Values shorter than 6 characters are ignored.
 * Additive — registering twice unions the sets. The values live in
 * process memory only; they are never logged or persisted.
 */
export function registerSecretValues(values: readonly string[]): void {
  const merged = new Set(registeredValues);
  for (const value of values) {
    if (typeof value !== 'string' || value.length < MIN_REGISTERED_VALUE_LENGTH) continue;
    merged.add(value);
    const encoded = encodeURIComponent(value);
    if (encoded !== value) merged.add(encoded);
  }
  registeredValues = [...merged].sort((a, b) => b.length - a.length);
}

/** Drop every registered value. For tests. */
export function clearRegisteredSecretValues(): void {
  registeredValues = [];
}

/**
 * Replace known secret patterns in a string with the literal
 * `[REDACTED]`. Safe to call on any string — if no patterns match,
 * the input comes back unchanged. Non-string inputs are coerced via
 * `String()` for defensive use at API boundaries.
 */
export function redactSecrets(input: string, options: RedactionOptions = {}): string {
  if (typeof input !== 'string') return String(input);
  const exemptions = options.exemptions?.filter((value) => value.length > 0) ?? [];
  if (exemptions.length > 0) {
    const spans: Array<[number, number]> = [];
    for (const exemption of exemptions) {
      let from = 0;
      while (from <= input.length - exemption.length) {
        const start = input.indexOf(exemption, from);
        if (start < 0) break;
        spans.push([start, start + exemption.length]);
        from = start + exemption.length;
      }
    }
    if (spans.length > 0) {
      spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
      const merged: Array<[number, number]> = [];
      for (const span of spans) {
        const last = merged.at(-1);
        if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
        else merged.push([...span]);
      }
      let cursor = 0;
      let out = '';
      for (const [start, end] of merged) {
        out += redactSecrets(input.slice(cursor, start));
        out += input.slice(start, end);
        cursor = end;
      }
      return out + redactSecrets(input.slice(cursor));
    }
  }
  let out = input;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  for (const value of registeredValues) {
    if (out.includes(value)) out = out.split(value).join(REDACTED);
  }
  return out;
}

/** Whether text contains a literal value currently registered for redaction. */
export function containsRegisteredSecretValue(input: string): boolean {
  return registeredValues.some((value) => input.includes(value));
}

/**
 * Redact a header map in place. Matches are case-insensitive on the
 * header name, so `Authorization` and `authorization` are both caught.
 * Non-sensitive header values also pass through `redactSecrets` in
 * case a rogue header like `X-Debug` happens to carry a key.
 */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (HEADERS_TO_STRIP.has(name.toLowerCase())) {
      out[name] = REDACTED;
    } else {
      out[name] = redactSecrets(value);
    }
  }
  return out;
}

/**
 * Walk any JSON-ish value and apply `redactSecrets` to every string
 * leaf. Objects and arrays are reconstructed so the caller's input
 * isn't mutated; every key and every array slot is preserved, so this
 * rewrites values and never drops structure.
 *
 * Non-object non-strings — numbers, booleans, `undefined`, functions,
 * symbols — are returned AS-IS. That keeps the function total, but do
 * not read it as sanitisation: a function or symbol survives this call
 * unchanged. (It is `JSON.stringify` at the serialisation boundary that
 * drops them, not this.) Verified by probe rather than by reading:
 * `typeof fn !== 'object'`, so functions take the passthrough branch.
 * Real trace data is parsed JSON and contains none of these.
 */
export function redactJson<T>(value: T, options: RedactionOptions = {}): T {
  if (typeof value === 'string') {
    return redactSecrets(value, options) as unknown as T;
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactJson(item, options)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = redactJson(v, options);
  }
  return out as unknown as T;
}
