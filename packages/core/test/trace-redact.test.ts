/**
 * Secret redaction tests — cover the three entry points
 * (`redactSecrets`, `redactHeaders`, `redactJson`) and all known
 * key patterns we scrub.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  clearRegisteredSecretValues,
  REDACTED,
  redactHeaders,
  redactJson,
  redactSecrets,
  registerSecretValues,
} from '../src/trace/redact.js';

describe('redactSecrets', () => {
  it('replaces Anthropic sk-ant- keys', () => {
    const input = 'header Authorization: Bearer sk-ant-api03-abc123def456ghi789jklmno end';
    expect(redactSecrets(input)).toContain(REDACTED);
    expect(redactSecrets(input)).not.toContain('sk-ant-api03');
  });

  it('replaces OpenAI sk- keys', () => {
    const input = 'Bearer sk-abcdef1234567890abcdef1234';
    const out = redactSecrets(input);
    expect(out).toContain(REDACTED);
    expect(out).not.toContain('sk-abcdef');
  });

  it('replaces AWS access key IDs', () => {
    const input = 'aws key AKIAIOSFODNN7EXAMPLE end';
    expect(redactSecrets(input)).toBe(`aws key ${REDACTED} end`);
  });

  it('replaces GitHub personal access tokens', () => {
    const input = 'token ghp_aaaaaaaaaaaaaaaaaaaaaaaa end';
    expect(redactSecrets(input)).toContain(REDACTED);
    expect(redactSecrets(input)).not.toContain('ghp_aaaaaa');
  });

  it('replaces Slack tokens', () => {
    const input = 'x=xoxb-1234567890-abcdef-secret end';
    expect(redactSecrets(input)).toContain(REDACTED);
  });

  it('leaves non-secret strings alone', () => {
    expect(redactSecrets('hello world')).toBe('hello world');
    expect(redactSecrets('model="claude-sonnet-4-6"')).toBe('model="claude-sonnet-4-6"');
  });
});

describe('redactHeaders', () => {
  it('strips case-insensitive Authorization headers', () => {
    const out = redactHeaders({
      Authorization: 'Bearer sk-ant-api03-real-looking-key-value-1234',
      'Content-Type': 'application/json',
    });
    expect(out.Authorization).toBe(REDACTED);
    expect(out['Content-Type']).toBe('application/json');
  });

  it('strips x-api-key, cookie, set-cookie, x-anthropic-api-key', () => {
    const out = redactHeaders({
      'x-api-key': 'abc',
      Cookie: 'session=xyz',
      'Set-Cookie': 'session=xyz; HttpOnly',
      'X-Anthropic-Api-Key': 'sk-ant-...',
    });
    expect(out['x-api-key']).toBe(REDACTED);
    expect(out.Cookie).toBe(REDACTED);
    expect(out['Set-Cookie']).toBe(REDACTED);
    expect(out['X-Anthropic-Api-Key']).toBe(REDACTED);
  });

  it('scans non-sensitive header values for leaked secrets', () => {
    const out = redactHeaders({
      'X-Debug': 'token=ghp_abcdefghijklmnopqrstuvwx',
    });
    expect(out['X-Debug']).toContain(REDACTED);
  });
});

describe('redactJson', () => {
  it('recursively redacts every string leaf in an object tree', () => {
    const input = {
      model: 'claude-sonnet-4-6',
      headers: {
        Authorization: 'Bearer sk-ant-api03-real-looking-key-value-1234',
      },
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello, here is a key: sk-abcdefghijklmnopqrstuv' },
      ],
      count: 42,
      active: true,
      nil: null,
    };
    const out = redactJson(input);
    expect(out.model).toBe('claude-sonnet-4-6');
    expect(out.headers.Authorization).toContain(REDACTED);
    expect(out.messages[1]?.content).toContain(REDACTED);
    expect(out.count).toBe(42);
    expect(out.active).toBe(true);
    expect(out.nil).toBeNull();
  });

  it('returns a new object instead of mutating input', () => {
    const input = { key: 'sk-abcdefghijklmnopqrstuv' };
    const out = redactJson(input);
    expect(out.key).toContain(REDACTED);
    expect(input.key).toBe('sk-abcdefghijklmnopqrstuv');
  });
});

describe('registered secret values', () => {
  afterEach(() => {
    clearRegisteredSecretValues();
  });

  it('scrubs arbitrary registered values with no recognizable shape', () => {
    registerSecretValues(['hunter2secret']);
    expect(redactSecrets('the password is hunter2secret, use it')).toBe(
      `the password is ${REDACTED}, use it`,
    );
  });

  it('scrubs every occurrence, not just the first', () => {
    registerSecretValues(['topsecretvalue']);
    const out = redactSecrets('a topsecretvalue b topsecretvalue c');
    expect(out).toBe(`a ${REDACTED} b ${REDACTED} c`);
  });

  it('scrubs values containing regex metacharacters literally', () => {
    registerSecretValues(['p@$$(w0rd)+[really].*special']);
    const out = redactSecrets('creds: p@$$(w0rd)+[really].*special done');
    expect(out).toBe(`creds: ${REDACTED} done`);
    // The metachars must not act as a pattern — an input that would
    // match the value as a regex but differs literally passes through.
    expect(redactSecrets('p@$$w0rd[really]x*special')).toBe('p@$$w0rd[really]x*special');
  });

  it('scrubs the URL-encoded form of a registered value', () => {
    registerSecretValues(['va lue&with=chars']);
    expect(redactSecrets('GET /cb?token=va%20lue%26with%3Dchars')).toContain(REDACTED);
    expect(redactSecrets('raw va lue&with=chars raw')).toContain(REDACTED);
  });

  it('ignores values shorter than 6 characters', () => {
    registerSecretValues(['dev', '12345']);
    expect(redactSecrets('dev build 12345')).toBe('dev build 12345');
  });

  it('handles overlapping values longest-first', () => {
    registerSecretValues(['secretvalue', 'secretvalue-extended']);
    expect(redactSecrets('x secretvalue-extended y')).toBe(`x ${REDACTED} y`);
  });

  it('is additive across register calls', () => {
    registerSecretValues(['firstsecret']);
    registerSecretValues(['secondsecret']);
    const out = redactSecrets('firstsecret and secondsecret');
    expect(out).toBe(`${REDACTED} and ${REDACTED}`);
  });

  it('flows through redactJson string leaves', () => {
    registerSecretValues(['deep-hidden-value']);
    const out = redactJson({
      tool_result: { stdout: 'GITHUB_TOKEN=deep-hidden-value\nPATH=/usr/bin' },
    });
    expect(out.tool_result.stdout).toBe(`GITHUB_TOKEN=${REDACTED}\nPATH=/usr/bin`);
  });
});

/**
 * These pin what the module header CLAIMS, so a future edit that makes
 * the claim false fails here rather than living on as a comment nobody
 * re-checks. Every case below corresponds to a sentence in
 * `redact.ts`'s doc comments — two of which were false when written.
 */
describe('redactJson — the documented contract', () => {
  afterEach(() => clearRegisteredSecretValues());

  it('rewrites values but never drops structure', () => {
    // Header claims: "every key and every array slot is preserved, so
    // this rewrites values and never drops structure."
    registerSecretValues(['registered-literal']);
    const input = {
      keep: 'registered-literal',
      nested: { arr: ['a', 'registered-literal', 'c'], n: 0, flag: false, nil: null },
      empty: {},
    };
    const out = redactJson(input);
    expect(Object.keys(out)).toEqual(['keep', 'nested', 'empty']);
    expect(Object.keys(out.nested)).toEqual(['arr', 'n', 'flag', 'nil']);
    // The array keeps its length AND its element positions — a filter
    // that dropped the redacted element would still be length 3 if it
    // appended, so assert the shape exactly.
    expect(out.nested.arr).toEqual(['a', REDACTED, 'c']);
    expect(out.nested.n).toBe(0);
    expect(out.nested.flag).toBe(false);
    expect(out.nested.nil).toBeNull();
    expect(out.empty).toEqual({});
  });

  it('scrubs content fields, not only transport metadata', () => {
    // Header claims content IS scrubbed. The previous header said the
    // opposite ("we never scrub message contents, tool arguments, or
    // model completions"), which is the claim this pins against.
    registerSecretValues(['registered-literal']);
    const out = redactJson({
      text: 'assistant said registered-literal',
      tool_use: { input: { cmd: 'echo registered-literal' } },
      tool_result: { content: 'registered-literal' },
      thinking: 'reasoning about registered-literal',
    });
    expect(out.text).toBe(`assistant said ${REDACTED}`);
    expect(out.tool_use.input.cmd).toBe(`echo ${REDACTED}`);
    expect(out.tool_result.content).toBe(REDACTED);
    expect(out.thinking).toBe(`reasoning about ${REDACTED}`);
  });

  it('passes functions and symbols through unchanged — it does not sanitise them', () => {
    // Header used to claim these were "coerced to null". They are not:
    // `typeof fn !== 'object'`, so they take the passthrough branch.
    const fn = () => 1;
    const sym = Symbol('s');
    const out = redactJson({ fn, sym, ok: 'plain' });
    expect(out.fn).toBe(fn);
    expect(out.sym).toBe(sym);
    expect(out.ok).toBe('plain');
  });

  it('leaves a string with nothing to redact byte-identical', () => {
    // The "refuses more than it should" direction: a redactor that
    // over-matched would still pass every assertion above.
    const clean = 'PATH=/usr/bin and a sha like 0f1e2d3c4b5a and normal prose.';
    expect(redactJson({ s: clean }).s).toBe(clean);
    expect(redactJson({ s: clean }).s).not.toContain(REDACTED);
  });
});
