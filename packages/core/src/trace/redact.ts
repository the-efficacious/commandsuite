/**
 * Secret redaction for captured HTTP traces.
 *
 * Decrypted Anthropic API traffic contains the operator's bearer
 * token in `Authorization: Bearer …` and often duplicates the same
 * key in URL params or request bodies on less polite APIs. Before any
 * of this leaves the runner (uploaded to the csuite server, shown in a
 * web UI, or written to disk for debugging), we scrub known-bad
 * patterns in place.
 *
 * Redaction philosophy:
 *   - Header-level: strip Authorization, x-api-key, cookie, set-cookie,
 *     proxy-authorization, x-anthropic-api-key entirely — replace the
 *     VALUE with `[REDACTED]` and keep the header name so structural
 *     analysis still works.
 *   - Body-level: pattern-match common key shapes (Anthropic `sk-ant-…`,
 *     OpenAI `sk-…`, AWS `AKIA…`, GitHub `ghp_…`, slack `xox…`) and
 *     replace the matched substring with `[REDACTED]`.
 *   - We never scrub message contents, tool arguments, or model
 *     completions — those are the whole point of the trace. If a user
 *     pastes a secret into a chat that's a different problem.
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
export function redactSecrets(input: string): string {
  if (typeof input !== 'string') return String(input);
  let out = input;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  for (const value of registeredValues) {
    if (out.includes(value)) out = out.split(value).join(REDACTED);
  }
  return out;
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
 * isn't mutated. Non-serializable values (functions, symbols) are
 * coerced to `null` — this shouldn't happen for real trace data but
 * keeps the function total.
 */
export function redactJson<T>(value: T): T {
  if (typeof value === 'string') {
    return redactSecrets(value) as unknown as T;
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactJson(item)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = redactJson(v);
  }
  return out as unknown as T;
}
