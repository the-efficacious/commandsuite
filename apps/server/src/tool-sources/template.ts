/**
 * Binding template engine for custom tool sources.
 *
 * A custom tool's HTTP binding may reference the caller's arguments
 * via `{{args.<name>}}` placeholders (top-level args only). This
 * module owns the grammar end-to-end: save-time validation
 * (`validateBinding`) and execute-time expansion (`expandBinding`).
 * It is pure — no I/O, no clock — so it unit-tests exhaustively.
 *
 * Substitution rules by context:
 *   - urlTemplate      — value is `encodeURIComponent(String(v))`.
 *                        Missing or non-scalar arg → template error.
 *   - header values    — `String(v)`; result must contain no CR/LF or
 *                        control characters (header injection guard).
 *   - string body      — raw `String(v)` interpolation.
 *   - JSON body, whole-token position (a string value that is exactly
 *     one placeholder) — replaced by the arg's raw JSON value
 *     (numbers/booleans/objects/arrays preserved). A MISSING arg
 *     omits the containing object key — this is what makes optional
 *     API parameters expressible. Inside an array a missing arg is a
 *     template error (there is no key to omit).
 *   - JSON body, embedded position ("prefix {{args.x}} suffix") —
 *     scalar interpolation; missing arg → template error.
 *
 * SSRF guard (the credential-exfiltration defense — both halves are
 * mandatory):
 *   1. Save time: the first `{{` must occur after the URL origin, so
 *      agent-supplied args can only influence path/query.
 *   2. Execute time: the expanded URL's origin must equal the origin
 *      computed at save time (re-derived here) — belt and braces
 *      against encoding tricks.
 *
 * Credential headers are NOT part of templates: `validateBinding`
 * rejects bindings that set `authorization` (or the source
 * credential's header, checked by the caller) so the executor's
 * post-expansion injection can never be shadowed.
 */

import type { CustomToolBinding } from 'csuite-sdk/types';

export type { CustomToolBinding };

export class BindingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BindingValidationError';
  }
}

/** Execute-time template failure — surfaces as a tool-level isError result. */
export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateError';
  }
}

const PLACEHOLDER = /\{\{args\.([A-Za-z_][A-Za-z0-9_]*)\}\}/g;
/** Any brace-pair that is not a well-formed placeholder. */
const STRAY_BRACES = /\{\{(?!args\.[A-Za-z_][A-Za-z0-9_]*\}\})/;

const METHODS_WITHOUT_BODY = new Set(['GET', 'DELETE']);
const HEADER_NAME_PATTERN = /^[A-Za-z0-9-]+$/;
const RESULT_PATH_SEGMENT = /^[A-Za-z0-9_$-]+$/;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 120_000;

/**
 * Reject any string containing a brace-pair that isn't an exact
 * `{{args.<name>}}` token — catches `{{arg.x}}` typos at save time
 * instead of silently passing them through as literal text.
 */
function assertWellFormedTokens(template: string, context: string): void {
  if (STRAY_BRACES.test(template)) {
    throw new BindingValidationError(
      `${context}: malformed placeholder — only \`{{args.<name>}}\` tokens are supported`,
    );
  }
}

/**
 * Compute the static origin of a URL template: the URL with every
 * placeholder neutralized. Throws when the URL is unparseable or a
 * placeholder appears at or before the origin boundary.
 */
export function staticOriginOf(urlTemplate: string): string {
  const neutralized = urlTemplate.replace(PLACEHOLDER, 'x');
  let parsed: URL;
  try {
    parsed = new URL(neutralized);
  } catch {
    throw new BindingValidationError(`urlTemplate is not a valid absolute URL: ${urlTemplate}`);
  }
  const firstToken = urlTemplate.indexOf('{{');
  if (firstToken !== -1) {
    const prefix = urlTemplate.slice(0, firstToken);
    // The static prefix alone must parse to the SAME origin — i.e.
    // the first placeholder sits strictly after the origin. `new
    // URL('https://host')` succeeds, `new URL('https://ho')` also
    // succeeds with a different origin, and `new URL('https://')`
    // throws — all three cases are handled by the comparison.
    let prefixOrigin: string;
    try {
      prefixOrigin = new URL(prefix).origin;
    } catch {
      throw new BindingValidationError(
        'urlTemplate: placeholders may not appear in the URL origin (scheme/host/port)',
      );
    }
    if (prefixOrigin !== parsed.origin) {
      throw new BindingValidationError(
        'urlTemplate: placeholders may not appear in the URL origin (scheme/host/port)',
      );
    }
  }
  return parsed.origin;
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    hostname.startsWith('127.')
  );
}

/**
 * Save-time validation. Throws `BindingValidationError` with a
 * message an operator can act on. `credentialHeaderName` is the
 * source credential's header (when kind=header) so a binding can't
 * shadow it.
 */
export function validateBinding(
  binding: CustomToolBinding,
  opts: { credentialHeaderName?: string | null } = {},
): void {
  // URL: well-formed tokens, parseable, https (http for loopback), static origin.
  assertWellFormedTokens(binding.urlTemplate, 'urlTemplate');
  const origin = staticOriginOf(binding.urlTemplate);
  const originUrl = new URL(origin);
  if (originUrl.protocol !== 'https:' && !isLoopbackHost(originUrl.hostname)) {
    throw new BindingValidationError(
      'urlTemplate: must use https (http is allowed for loopback hosts only)',
    );
  }

  // Headers: static valid names, well-formed tokens in values, no
  // credential shadowing.
  const reserved = new Set(['authorization']);
  if (opts.credentialHeaderName) reserved.add(opts.credentialHeaderName.toLowerCase());
  for (const [name, value] of Object.entries(binding.headers ?? {})) {
    if (!HEADER_NAME_PATTERN.test(name)) {
      throw new BindingValidationError(`headers: invalid header name "${name}"`);
    }
    if (reserved.has(name.toLowerCase())) {
      throw new BindingValidationError(
        `headers: "${name}" is injected from the source credential and cannot be templated`,
      );
    }
    assertWellFormedTokens(value, `headers.${name}`);
  }

  // Body/method compatibility + token well-formedness.
  if (binding.bodyTemplate !== undefined && METHODS_WITHOUT_BODY.has(binding.method)) {
    throw new BindingValidationError(`bodyTemplate is not allowed with method ${binding.method}`);
  }
  if (typeof binding.bodyTemplate === 'string') {
    assertWellFormedTokens(binding.bodyTemplate, 'bodyTemplate');
  } else if (binding.bodyTemplate !== undefined) {
    walkJsonTemplate(binding.bodyTemplate, (s, path) => {
      assertWellFormedTokens(s, `bodyTemplate.${path}`);
    });
  }

  if (binding.resultPath !== undefined) {
    const segments = binding.resultPath.split('.');
    if (segments.length === 0 || segments.some((s) => !RESULT_PATH_SEGMENT.test(s))) {
      throw new BindingValidationError(
        'resultPath: must be a dot-path of alphanumeric/_/$/- segments (array indexes as digits)',
      );
    }
  }

  if (binding.timeoutMs !== undefined) {
    if (binding.timeoutMs < MIN_TIMEOUT_MS || binding.timeoutMs > MAX_TIMEOUT_MS) {
      throw new BindingValidationError(
        `timeoutMs: must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`,
      );
    }
  }
}

/** Visit every string value in a JSON template (depth-first). */
function walkJsonTemplate(
  node: unknown,
  visit: (s: string, path: string) => void,
  path = '',
): void {
  if (typeof node === 'string') {
    visit(node, path);
    return;
  }
  if (Array.isArray(node)) {
    for (const [i, v] of node.entries()) {
      walkJsonTemplate(v, visit, path ? `${path}.${i}` : String(i));
    }
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      walkJsonTemplate(v, visit, path ? `${path}.${k}` : k);
    }
  }
}

export interface ExpandedRequest {
  url: string;
  headers: Record<string, string>;
  /** Serialized body, or null when the binding has none. */
  body: string | null;
  contentType: string | null;
  timeoutMs: number;
}

function isScalar(v: unknown): v is string | number | boolean {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

/**
 * Expand a validated binding against the caller's args. Throws
 * `TemplateError` (→ tool-level isError result) before any network
 * I/O can happen. Re-checks the static-origin invariant on the final
 * URL.
 */
export function expandBinding(
  binding: CustomToolBinding,
  args: Record<string, unknown>,
): ExpandedRequest {
  // Null-prototype lookup map so `__proto__`/`constructor` keys in
  // the payload can't pollute or alias anything.
  const lookup: Record<string, unknown> = Object.assign(Object.create(null), args);

  const substituteScalar = (template: string, context: string): string =>
    template.replace(PLACEHOLDER, (_m, name: string) => {
      const v = lookup[name];
      if (v === undefined) {
        throw new TemplateError(
          `template error: {{args.${name}}} is required by this tool's ${context} but was not provided`,
        );
      }
      if (!isScalar(v)) {
        throw new TemplateError(
          `template error: {{args.${name}}} in the ${context} must be a string, number, or boolean`,
        );
      }
      return String(v);
    });

  // URL — encode each substitution, then re-verify the origin.
  const staticOrigin = staticOriginOf(binding.urlTemplate);
  const url = binding.urlTemplate.replace(PLACEHOLDER, (_m, name: string) => {
    const v = lookup[name];
    if (v === undefined) {
      throw new TemplateError(
        `template error: {{args.${name}}} is required by this tool's URL but was not provided`,
      );
    }
    if (!isScalar(v)) {
      throw new TemplateError(
        `template error: {{args.${name}}} in the URL must be a string, number, or boolean`,
      );
    }
    return encodeURIComponent(String(v));
  });
  let finalUrl: URL;
  try {
    finalUrl = new URL(url);
  } catch {
    throw new TemplateError('template error: expanded URL is not valid');
  }
  if (finalUrl.origin !== staticOrigin) {
    throw new TemplateError('template error: expanded URL escaped the configured origin');
  }

  // Headers — scalar substitution + injection guard on the result.
  const headers: Record<string, string> = {};
  for (const [name, valueTemplate] of Object.entries(binding.headers ?? {})) {
    const value = substituteScalar(valueTemplate, `"${name}" header`);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: header injection guard
    if (/[\r\n\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
      throw new TemplateError(
        `template error: expanded value for header "${name}" contains control characters`,
      );
    }
    headers[name] = value;
  }

  // Body.
  let body: string | null = null;
  let contentType: string | null = binding.contentType ?? null;
  if (typeof binding.bodyTemplate === 'string') {
    body = substituteScalar(binding.bodyTemplate, 'body');
    contentType ??= 'text/plain; charset=utf-8';
  } else if (binding.bodyTemplate !== undefined) {
    body = JSON.stringify(expandJsonTemplate(binding.bodyTemplate, lookup));
    contentType ??= 'application/json';
  }

  const timeoutMs = Math.min(
    Math.max(binding.timeoutMs ?? DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS),
    MAX_TIMEOUT_MS,
  );

  return { url: finalUrl.toString(), headers, body, contentType, timeoutMs };
}

/** Sentinel returned by expandJsonNode when a whole-token arg is absent. */
const OMIT = Symbol('omit');

function expandJsonTemplate(node: unknown, lookup: Record<string, unknown>): unknown {
  const result = expandJsonNode(node, lookup, 'root');
  if (result === OMIT) {
    throw new TemplateError('template error: the entire body resolved to a missing argument');
  }
  return result;
}

function expandJsonNode(
  node: unknown,
  lookup: Record<string, unknown>,
  path: string,
): unknown | typeof OMIT {
  if (typeof node === 'string') {
    // Whole-token position: the string is exactly one placeholder →
    // the raw JSON value rides through (or the key is omitted).
    const whole = /^\{\{args\.([A-Za-z_][A-Za-z0-9_]*)\}\}$/.exec(node);
    if (whole) {
      const name = whole[1] as string;
      const v = lookup[name];
      if (v === undefined) return OMIT;
      return v;
    }
    // Embedded position: scalar interpolation, missing → error.
    return node.replace(PLACEHOLDER, (_m, name: string) => {
      const v = lookup[name];
      if (v === undefined) {
        throw new TemplateError(
          `template error: {{args.${name}}} at body ${path} was not provided`,
        );
      }
      if (!isScalar(v)) {
        throw new TemplateError(
          `template error: {{args.${name}}} at body ${path} must be a string, number, or boolean`,
        );
      }
      return String(v);
    });
  }
  if (Array.isArray(node)) {
    return node.map((v, i) => {
      const expanded = expandJsonNode(v, lookup, `${path}.${i}`);
      if (expanded === OMIT) {
        throw new TemplateError(
          `template error: a required argument at body ${path}.${i} was not provided (array entries cannot be omitted)`,
        );
      }
      return expanded;
    });
  }
  if (node !== null && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      const expanded = expandJsonNode(v, lookup, `${path}.${k}`);
      if (expanded === OMIT) continue; // optional param: omit the key
      out[k] = expanded;
    }
    return out;
  }
  return node;
}

/**
 * Walk a dot-path into a parsed JSON value. Returns `undefined` when
 * any segment misses — callers fall back to the full document with a
 * notice rather than erroring.
 */
export function walkResultPath(value: unknown, resultPath: string): unknown {
  let current: unknown = value;
  for (const segment of resultPath.split('.')) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const idx = Number(segment);
      if (!Number.isInteger(idx)) return undefined;
      current = current[idx];
    } else if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}
