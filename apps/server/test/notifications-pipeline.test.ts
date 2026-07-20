/**
 * Unit tests for the External Notifications pipeline pieces —
 * signature verification (HMAC + header-secret), filter rules,
 * template rendering, and message composition (the non-templatable
 * provenance wrap).
 */

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { DeliveryRecord } from '../src/notifications/index.js';
import {
  applyFilters,
  composeBody,
  defaultRender,
  getPath,
  renderTemplate,
  verifyInbound,
} from '../src/notifications/index.js';

const SECRET = 'shhh-signing-secret';

function sign(body: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');
}

function headers(map: Record<string, string>): (name: string) => string | undefined {
  const lower = Object.fromEntries(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return (name) => lower[name.toLowerCase()];
}

describe('verifyInbound — hmac-sha256', () => {
  const auth = { kind: 'hmac-sha256' as const, headerName: null, prefix: null, secret: SECRET };

  it('accepts a GitHub-style signature on the default header', () => {
    const body = '{"action":"opened"}';
    const result = verifyInbound(
      auth,
      Buffer.from(body),
      headers({ 'X-Hub-Signature-256': `sha256=${sign(body)}` }),
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a bad signature', () => {
    const result = verifyInbound(
      auth,
      Buffer.from('{"a":1}'),
      headers({ 'X-Hub-Signature-256': `sha256=${sign('{"a":2}')}` }),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects a missing header and a missing prefix', () => {
    const body = '{}';
    expect(verifyInbound(auth, Buffer.from(body), headers({})).ok).toBe(false);
    expect(
      verifyInbound(auth, Buffer.from(body), headers({ 'X-Hub-Signature-256': sign(body) })).ok,
    ).toBe(false);
  });

  it('honors a custom header and empty prefix', () => {
    const custom = { ...auth, headerName: 'x-sig', prefix: '' };
    const body = 'raw text body';
    expect(verifyInbound(custom, Buffer.from(body), headers({ 'X-Sig': sign(body) })).ok).toBe(
      true,
    );
  });

  it('verifies over the exact bytes — a reserialized body fails', () => {
    const sent = '{"a": 1}';
    const reserialized = '{"a":1}';
    expect(
      verifyInbound(
        auth,
        Buffer.from(reserialized),
        headers({ 'X-Hub-Signature-256': `sha256=${sign(sent)}` }),
      ).ok,
    ).toBe(false);
  });

  it('fails closed with no secret', () => {
    const result = verifyInbound({ ...auth, secret: null }, Buffer.from('{}'), headers({}));
    expect(result.ok).toBe(false);
  });
});

describe('verifyInbound — header-secret', () => {
  const auth = { kind: 'header-secret' as const, headerName: null, prefix: null, secret: SECRET };

  it('accepts the shared secret on the default header', () => {
    expect(verifyInbound(auth, Buffer.from('x'), headers({ 'X-Hook-Secret': SECRET })).ok).toBe(
      true,
    );
  });

  it('rejects a wrong or absent secret', () => {
    expect(verifyInbound(auth, Buffer.from('x'), headers({ 'X-Hook-Secret': 'nope' })).ok).toBe(
      false,
    );
    expect(verifyInbound(auth, Buffer.from('x'), headers({})).ok).toBe(false);
  });
});

describe('filters', () => {
  const payload = {
    action: 'opened',
    check_run: { conclusion: 'failure' },
    labels: ['bug', 'p1'],
  };

  it('getPath resolves dot-paths', () => {
    expect(getPath(payload, 'check_run.conclusion')).toBe('failure');
    expect(getPath(payload, 'check_run.missing')).toBeUndefined();
  });

  it('eq / ne / in / exists / contains', () => {
    expect(applyFilters([{ path: 'action', op: 'eq', value: 'opened' }], payload).pass).toBe(true);
    expect(applyFilters([{ path: 'action', op: 'ne', value: 'closed' }], payload).pass).toBe(true);
    expect(
      applyFilters([{ path: 'action', op: 'in', value: ['opened', 'reopened'] }], payload).pass,
    ).toBe(true);
    expect(applyFilters([{ path: 'check_run', op: 'exists' }], payload).pass).toBe(true);
    expect(applyFilters([{ path: 'labels', op: 'contains', value: 'p1' }], payload).pass).toBe(
      true,
    );
    expect(applyFilters([{ path: 'action', op: 'eq', value: 'closed' }], payload).pass).toBe(false);
  });

  it('ANDs rules and fails non-JSON bodies when rules exist', () => {
    expect(
      applyFilters(
        [
          { path: 'action', op: 'eq', value: 'opened' },
          { path: 'check_run.conclusion', op: 'eq', value: 'success' },
        ],
        payload,
      ).pass,
    ).toBe(false);
    expect(applyFilters([{ path: 'a', op: 'exists' }], undefined).pass).toBe(false);
    expect(applyFilters([], undefined).pass).toBe(true);
  });
});

describe('templates', () => {
  it('substitutes dot-paths, whole payload, and missing → empty', () => {
    const payload = { repo: 'csuite', run: { status: 'failed', num: 7 } };
    expect(
      renderTemplate('CI {{payload.run.status}} on {{payload.repo}} #{{payload.run.num}}', payload),
    ).toBe('CI failed on csuite #7');
    expect(renderTemplate('missing: [{{payload.nope.deep}}]', payload)).toBe('missing: []');
    expect(renderTemplate('{{payload}}', { a: 1 })).toBe('{"a":1}');
  });

  it('defaultRender pretty-prints JSON and passes raw text through', () => {
    expect(defaultRender('{"a":1}', { a: 1 })).toBe('{\n  "a": 1\n}');
    expect(defaultRender('plain text', undefined)).toBe('plain text');
  });
});

function delivery(partial: Partial<DeliveryRecord>): DeliveryRecord {
  return {
    id: 'd-1',
    endpointId: 'e-1',
    endpointSlug: 'ci-alerts',
    receivedAt: 1_700_000_000_000,
    status: 'pending',
    statusReason: null,
    dedupeKey: null,
    messageIds: [],
    body: '{}',
    contentType: 'application/json',
    rendered: 'CI failed on main',
    level: 'warning',
    title: null,
    overrides: null,
    deliveredAt: null,
    replayOf: null,
    ...partial,
  };
}

describe('composeBody — the provenance wrap', () => {
  it('frames a single delivery with endpoint, delivery id, and the untrusted-input contract', () => {
    const body = composeBody({
      endpointSlug: 'ci-alerts',
      displayName: 'CI Alerts',
      deliveries: [delivery({})],
      now: 1_700_000_010_000,
    });
    expect(body).toContain('External notification from endpoint "ci-alerts" (CI Alerts)');
    expect(body).toContain('untrusted input');
    expect(body).toContain('<external_content endpoint="ci-alerts" delivery="d-1"');
    expect(body).toContain('CI failed on main');
    expect(body).toContain('</external_content>');
  });

  it('states queue and coalesce facts in the preamble', () => {
    const body = composeBody({
      endpointSlug: 'ci-alerts',
      displayName: '',
      deliveries: [
        delivery({ id: 'd-2', receivedAt: 1_700_000_120_000, rendered: 'RENDERED-NEW' }),
        delivery({ id: 'd-1', receivedAt: 1_700_000_000_000, rendered: 'RENDERED-OLD' }),
      ],
      queuedMs: 47 * 60_000,
      queuedReason: 'offline',
      now: 1_700_003_000_000,
    });
    expect(body).toContain('2 deliveries coalesced');
    expect(body).toContain('queued 47m while you were offline');
    // Newest first.
    expect(body.indexOf('RENDERED-NEW')).toBeLessThan(body.indexOf('RENDERED-OLD'));
  });

  it('omits older deliveries past the size cap with a receipt pointer', () => {
    const deliveries = Array.from({ length: 30 }, (_, i) =>
      delivery({
        id: `d-${i}`,
        receivedAt: 1_700_000_000_000 + (30 - i) * 1000,
        rendered: 'x'.repeat(2000),
      }),
    );
    const body = composeBody({
      endpointSlug: 'noisy',
      displayName: '',
      deliveries,
      now: 1_700_000_100_000,
    });
    expect(body.length).toBeLessThan(30 * 2000);
    expect(body).toMatch(/\d+ older deliver(y|ies) omitted/);
  });
});
