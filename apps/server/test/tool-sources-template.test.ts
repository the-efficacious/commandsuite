/**
 * Template engine tests — the security-relevant core of custom tool
 * sources. The SSRF static-origin guard and the header-injection
 * rejection are load-bearing: a regression here hands agent-supplied
 * args control over where a credentialed request goes.
 */

import type { CustomToolBinding } from 'csuite-sdk/types';
import { describe, expect, it } from 'vitest';
import {
  BindingValidationError,
  expandBinding,
  TemplateError,
  validateBinding,
  walkResultPath,
} from '../src/tool-sources/template.js';

const base = (overrides: Partial<CustomToolBinding> = {}): CustomToolBinding => ({
  method: 'GET',
  urlTemplate: 'https://api.example.com/v1/items/{{args.id}}',
  ...overrides,
});

describe('validateBinding', () => {
  it('accepts a well-formed binding', () => {
    expect(() => validateBinding(base())).not.toThrow();
  });

  it('rejects placeholders in the URL origin (SSRF guard)', () => {
    for (const urlTemplate of [
      'https://{{args.host}}/v1/items',
      'https://api.{{args.env}}.example.com/v1',
      '{{args.url}}',
      'https://api.example.com{{args.port}}/v1',
    ]) {
      expect(() => validateBinding(base({ urlTemplate }))).toThrow(BindingValidationError);
    }
  });

  it('rejects non-https URLs except loopback', () => {
    expect(() => validateBinding(base({ urlTemplate: 'http://api.example.com/x' }))).toThrow(
      /https/,
    );
    expect(() =>
      validateBinding(base({ urlTemplate: 'http://127.0.0.1:9999/x/{{args.id}}' })),
    ).not.toThrow();
    expect(() => validateBinding(base({ urlTemplate: 'http://localhost:3000/x' }))).not.toThrow();
  });

  it('rejects malformed placeholder tokens at save time', () => {
    expect(() =>
      validateBinding(base({ urlTemplate: 'https://api.example.com/{{arg.id}}' })),
    ).toThrow(/malformed placeholder/);
    expect(() =>
      validateBinding(base({ urlTemplate: 'https://api.example.com/{{args.}}' })),
    ).toThrow(/malformed placeholder/);
  });

  it('rejects templating the authorization header (credential shadowing)', () => {
    expect(() =>
      validateBinding(base({ headers: { Authorization: 'Bearer {{args.token}}' } })),
    ).toThrow(/injected from the source credential/);
  });

  it('rejects templating the credential header when one is configured', () => {
    expect(() =>
      validateBinding(base({ headers: { 'X-Api-Key': 'abc' } }), {
        credentialHeaderName: 'X-Api-Key',
      }),
    ).toThrow(/injected from the source credential/);
  });

  it('rejects bodies on GET/DELETE', () => {
    expect(() => validateBinding(base({ method: 'GET', bodyTemplate: 'x' }))).toThrow(
      /not allowed with method GET/,
    );
  });

  it('rejects bad resultPath segments and out-of-range timeouts', () => {
    expect(() => validateBinding(base({ resultPath: 'a..b' }))).toThrow(/resultPath/);
    expect(() => validateBinding(base({ timeoutMs: 10 }))).toThrow(/timeoutMs/);
  });
});

describe('expandBinding', () => {
  it('URL-encodes substitutions and preserves the origin', () => {
    const expanded = expandBinding(base(), { id: 'a b/../c' });
    expect(expanded.url).toBe('https://api.example.com/v1/items/a%20b%2F..%2Fc');
  });

  it('rejects origin-hostile templates even when save-time validation was bypassed', () => {
    // encodeURIComponent makes escaping a validated origin impossible
    // at expansion time, so the residual risk is a binding that never
    // went through validateBinding (e.g. hand-edited DB row). Expansion
    // re-derives the static origin and refuses before any I/O.
    expect(() =>
      expandBinding(
        { method: 'GET', urlTemplate: 'https://api.example.com:{{args.p}}/x' },
        { p: '444' },
      ),
    ).toThrow(/not a valid absolute URL|origin/);
  });

  it('errors before I/O on missing or non-scalar URL args', () => {
    expect(() => expandBinding(base(), {})).toThrow(/required by this tool's URL/);
    expect(() => expandBinding(base(), { id: { nested: true } })).toThrow(
      /must be a string, number, or boolean/,
    );
  });

  it('rejects control characters in expanded header values', () => {
    const binding = base({ headers: { 'X-Trace': '{{args.trace}}' } });
    expect(() => expandBinding(binding, { id: '1', trace: 'ok\r\nInjected: yes' })).toThrow(
      /control characters/,
    );
  });

  it('ignores prototype-pollution keys in args', () => {
    const binding = base({ urlTemplate: 'https://api.example.com/{{args.constructor}}' });
    expect(() => expandBinding(binding, JSON.parse('{"__proto__": {"x": 1}}'))).toThrow(
      /required by this tool's URL/,
    );
  });

  describe('JSON body templates', () => {
    const binding = (bodyTemplate: Record<string, unknown>): CustomToolBinding => ({
      method: 'POST',
      urlTemplate: 'https://api.example.com/v1/items',
      bodyTemplate,
    });

    it('whole-token position preserves raw JSON values', () => {
      const expanded = expandBinding(
        binding({ count: '{{args.count}}', tags: '{{args.tags}}', note: 'n: {{args.note}}' }),
        { count: 3, tags: ['a', 'b'], note: 'hi' },
      );
      expect(JSON.parse(expanded.body as string)).toEqual({
        count: 3,
        tags: ['a', 'b'],
        note: 'n: hi',
      });
      expect(expanded.contentType).toBe('application/json');
    });

    it('missing whole-token arg omits the containing key (optional params)', () => {
      const expanded = expandBinding(binding({ required: '{{args.a}}', optional: '{{args.b}}' }), {
        a: 1,
      });
      expect(JSON.parse(expanded.body as string)).toEqual({ required: 1 });
    });

    it('missing embedded arg is an error', () => {
      expect(() => expandBinding(binding({ note: 'x {{args.b}}' }), {})).toThrow(TemplateError);
    });

    it('missing whole-token arg inside an array is an error', () => {
      expect(() =>
        expandBinding(
          { method: 'POST', urlTemplate: 'https://x.example.com/', bodyTemplate: ['{{args.b}}'] },
          {},
        ),
      ).toThrow(/array entries cannot be omitted/);
    });
  });

  it('string bodies interpolate raw with text/plain default', () => {
    const expanded = expandBinding(
      {
        method: 'POST',
        urlTemplate: 'https://api.example.com/v1',
        bodyTemplate: 'summary={{args.summary}}',
      },
      { summary: 'a&b' },
    );
    expect(expanded.body).toBe('summary=a&b');
    expect(expanded.contentType).toBe('text/plain; charset=utf-8');
  });

  it('clamps timeouts into [1s, 120s] with a 30s default', () => {
    expect(expandBinding(base(), { id: '1' }).timeoutMs).toBe(30_000);
    expect(expandBinding(base({ timeoutMs: 90_000 }), { id: '1' }).timeoutMs).toBe(90_000);
  });
});

describe('walkResultPath', () => {
  const doc = { issues: [{ key: 'PROJ-1', fields: { summary: 's' } }], total: 1 };

  it('walks objects and array indexes', () => {
    expect(walkResultPath(doc, 'issues.0.key')).toBe('PROJ-1');
    expect(walkResultPath(doc, 'total')).toBe(1);
  });

  it('returns undefined on any miss', () => {
    expect(walkResultPath(doc, 'issues.5.key')).toBeUndefined();
    expect(walkResultPath(doc, 'nope.deep')).toBeUndefined();
    expect(walkResultPath(doc, 'issues.x')).toBeUndefined();
  });
});
