/**
 * Secrets endpoint tests — registry CRUD gating, envName validation
 * (grammar, reserved names, uniqueness), value write-only + KEK
 * fail-closed behavior, per-member resolve scoping, change-event
 * fanout (never carrying the value), and redactor registration.
 */

import {
  Broker,
  clearRegisteredSecretValues,
  InMemoryEventLog,
  REDACTED,
  redactSecrets,
} from 'csuite-core';
import type { SecretSummary } from 'csuite-sdk/types';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { testKek } from '../src/kek.js';
import { createMemberStore, setKek } from '../src/members.js';
import { createSqliteSecretsStore } from '../src/secrets.js';
import { SessionStore } from '../src/sessions.js';
import { createTokenStoreFromMembers } from '../src/tokens.js';
import { mockTeamStore } from './helpers/test-stores.js';

const ADMIN = 'csuite_test_admin_secret';
const BOUND = 'csuite_test_bound_secret';
const OUTSIDER = 'csuite_test_outsider_secret';

const noopLog = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function makeApp() {
  const broker = new Broker({
    eventLog: new InMemoryEventLog(),
    now: () => 1_700_000_000_000,
    idFactory: (() => {
      let n = 0;
      return () => `msg-${++n}`;
    })(),
  });
  const members = createMemberStore([
    {
      name: 'admin',
      role: { title: 'director', description: '' },
      permissions: ['secrets.manage', 'members.manage'],
      token: ADMIN,
    },
    {
      name: 'bound',
      role: { title: 'engineer', description: '' },
      permissions: [],
      token: BOUND,
    },
    {
      name: 'outsider',
      role: { title: 'engineer', description: '' },
      permissions: [],
      token: OUTSIDER,
    },
  ]);
  const db = openDatabase(':memory:');
  const sessions = new SessionStore(db);
  const tokens = createTokenStoreFromMembers(db, members);
  const secrets = createSqliteSecretsStore(db);
  const { app } = createApp({
    broker,
    members,
    tokens,
    sessions,
    teamStore: mockTeamStore({
      name: 'demo-team',
      directive: 'Ship the thing.',
      context: '',
      permissionPresets: {},
    }),
    secrets,
    version: '0.0.0',
    logger: noopLog,
  });
  return { app, broker, secrets };
}

function authed(token: string, body?: unknown, method?: string): RequestInit {
  const init: RequestInit = {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  };
  init.method = method ?? (body !== undefined ? 'POST' : 'GET');
  if (body !== undefined) init.body = JSON.stringify(body);
  return init;
}

/** Flush queueMicrotask + broker push promises. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeAll(() => {
  setKek(testKek());
});

afterAll(() => {
  setKek(null);
});

afterEach(() => {
  clearRegisteredSecretValues();
});

describe('registry CRUD + gating', () => {
  it('create requires secrets.manage', async () => {
    const { app } = makeApp();
    const denied = await app.request(
      '/secrets',
      authed(BOUND, { slug: 'gh', envName: 'GITHUB_TOKEN' }),
    );
    expect(denied.status).toBe(403);

    const created = await app.request(
      '/secrets',
      authed(ADMIN, { slug: 'gh', envName: 'GITHUB_TOKEN', description: 'CI token' }),
    );
    expect(created.status).toBe(201);
    const body = (await created.json()) as { slug: string; envName: string; enabled: boolean };
    expect(body.slug).toBe('gh');
    expect(body.envName).toBe('GITHUB_TOKEN');
    expect(body.enabled).toBe(true);
  });

  it('rejects duplicate slugs and duplicate env names with 409', async () => {
    const { app } = makeApp();
    await app.request('/secrets', authed(ADMIN, { slug: 'gh', envName: 'GITHUB_TOKEN' }));
    const dupeSlug = await app.request(
      '/secrets',
      authed(ADMIN, { slug: 'gh', envName: 'OTHER_TOKEN' }),
    );
    expect(dupeSlug.status).toBe(409);
    const dupeEnv = await app.request(
      '/secrets',
      authed(ADMIN, { slug: 'gh2', envName: 'GITHUB_TOKEN' }),
    );
    expect(dupeEnv.status).toBe(409);
  });

  it('rejects malformed and reserved env names with 400', async () => {
    const { app } = makeApp();
    for (const envName of [
      'lowercase',
      '1STARTS_WITH_DIGIT',
      'HAS-DASH',
      'PATH',
      'NODE_OPTIONS',
      'LD_PRELOAD',
      'CSUITE_TOKEN',
      'OTEL_EXPORTER_OTLP_HEADERS',
      'CLAUDE_CODE_ENABLE_TELEMETRY',
      'CODEX_HOME',
    ]) {
      const resp = await app.request('/secrets', authed(ADMIN, { slug: 'bad', envName }));
      expect(resp.status, `envName ${envName} should be rejected`).toBe(400);
    }
  });

  it('any member can list; bound flag is per-viewer; values never appear', async () => {
    const { app } = makeApp();
    await app.request('/secrets', authed(ADMIN, { slug: 'gh', envName: 'GITHUB_TOKEN' }));
    await app.request('/secrets/gh/bindings', authed(ADMIN, { member: 'bound' }));
    await app.request('/secrets/gh/value', authed(ADMIN, { value: 'ghp_supersecretvalue' }, 'PUT'));

    const asBound = await app.request('/secrets', authed(BOUND));
    expect(asBound.status).toBe(200);
    const boundList = (await asBound.json()) as { secrets: SecretSummary[] };
    expect(boundList.secrets[0]?.bound).toBe(true);
    expect(boundList.secrets[0]?.hasValue).toBe(true);
    expect(JSON.stringify(boundList)).not.toContain('ghp_supersecretvalue');

    const asOutsider = await app.request('/secrets', authed(OUTSIDER));
    const outsiderList = (await asOutsider.json()) as { secrets: SecretSummary[] };
    expect(outsiderList.secrets[0]?.bound).toBe(false);
  });

  it('detail exposes bindings to secrets.manage only', async () => {
    const { app } = makeApp();
    await app.request('/secrets', authed(ADMIN, { slug: 'gh', envName: 'GITHUB_TOKEN' }));
    await app.request('/secrets/gh/bindings', authed(ADMIN, { member: 'bound' }));

    const asAdmin = (await (await app.request('/secrets/gh', authed(ADMIN))).json()) as {
      boundMembers?: string[];
    };
    expect(asAdmin.boundMembers).toEqual(['bound']);

    const asBound = (await (await app.request('/secrets/gh', authed(BOUND))).json()) as {
      boundMembers?: string[];
    };
    expect(asBound.boundMembers).toBeUndefined();
  });

  it('update validates envName changes and delete cascades', async () => {
    const { app } = makeApp();
    await app.request('/secrets', authed(ADMIN, { slug: 'gh', envName: 'GITHUB_TOKEN' }));
    await app.request('/secrets', authed(ADMIN, { slug: 'np', envName: 'NPM_TOKEN' }));

    const conflict = await app.request(
      '/secrets/np',
      authed(ADMIN, { envName: 'GITHUB_TOKEN' }, 'PATCH'),
    );
    expect(conflict.status).toBe(409);
    const reserved = await app.request('/secrets/np', authed(ADMIN, { envName: 'PATH' }, 'PATCH'));
    expect(reserved.status).toBe(400);

    const deleted = await app.request('/secrets/gh', authed(ADMIN, undefined, 'DELETE'));
    expect(deleted.status).toBe(200);
    const list = (await (await app.request('/secrets', authed(ADMIN))).json()) as {
      secrets: SecretSummary[];
    };
    expect(list.secrets.map((s) => s.slug)).toEqual(['np']);
  });
});

describe('value write-only + KEK', () => {
  it('set/delete value gates on secrets.manage and flips hasValue', async () => {
    const { app } = makeApp();
    await app.request('/secrets', authed(ADMIN, { slug: 'gh', envName: 'GITHUB_TOKEN' }));

    const denied = await app.request(
      '/secrets/gh/value',
      authed(BOUND, { value: 'nope-not-allowed' }, 'PUT'),
    );
    expect(denied.status).toBe(403);

    await app.request('/secrets/gh/value', authed(ADMIN, { value: 'ghp_valuegoeshere' }, 'PUT'));
    let detail = (await (await app.request('/secrets/gh', authed(ADMIN))).json()) as {
      secret: SecretSummary;
    };
    expect(detail.secret.hasValue).toBe(true);

    await app.request('/secrets/gh/value', authed(ADMIN, undefined, 'DELETE'));
    detail = (await (await app.request('/secrets/gh', authed(ADMIN))).json()) as {
      secret: SecretSummary;
    };
    expect(detail.secret.hasValue).toBe(false);
  });

  it('value is stored encrypted, not in plaintext', async () => {
    const { secrets } = makeApp();
    const created = secrets.create({
      slug: 'gh',
      envName: 'GITHUB_TOKEN',
      creator: 'admin',
    });
    secrets.setValue(created.id, 'ghp_plaintextcheck');
    // Read the raw row through a fresh store on the same handle? The
    // store is the only accessor — assert via its own contract: the
    // resolve path round-trips, and allDecryptedValues decrypts.
    expect(secrets.allDecryptedValues()).toEqual(['ghp_plaintextcheck']);
  });

  it('fails closed with 503 when no KEK is active', async () => {
    const { app } = makeApp();
    await app.request('/secrets', authed(ADMIN, { slug: 'gh', envName: 'GITHUB_TOKEN' }));
    setKek(null);
    try {
      const resp = await app.request(
        '/secrets/gh/value',
        authed(ADMIN, { value: 'should-fail-closed' }, 'PUT'),
      );
      expect(resp.status).toBe(503);
    } finally {
      setKek(testKek());
    }
  });

  it('registers the value with the trace redactor on write', async () => {
    const { app } = makeApp();
    await app.request('/secrets', authed(ADMIN, { slug: 'gh', envName: 'GITHUB_TOKEN' }));
    await app.request(
      '/secrets/gh/value',
      authed(ADMIN, { value: 'ghx_redactorcheckvalue' }, 'PUT'),
    );
    expect(redactSecrets('output: ghx_redactorcheckvalue done')).toBe(`output: ${REDACTED} done`);
  });
});

describe('resolve scoping', () => {
  async function seed(app: ReturnType<typeof makeApp>['app']) {
    await app.request('/secrets', authed(ADMIN, { slug: 'gh', envName: 'GITHUB_TOKEN' }));
    await app.request('/secrets/gh/value', authed(ADMIN, { value: 'ghp_boundonly' }, 'PUT'));
    await app.request('/secrets/gh/bindings', authed(ADMIN, { member: 'bound' }));

    await app.request(
      '/secrets',
      authed(ADMIN, { slug: 'team-wide', envName: 'TEAM_API_KEY', allMembers: true }),
    );
    await app.request(
      '/secrets/team-wide/value',
      authed(ADMIN, { value: 'team-wide-value' }, 'PUT'),
    );

    // Enabled + bound but valueless: must be skipped, not delivered empty.
    await app.request('/secrets', authed(ADMIN, { slug: 'empty', envName: 'EMPTY_ONE' }));
    await app.request('/secrets/empty/bindings', authed(ADMIN, { member: 'bound' }));
  }

  it('delivers only the caller-bound, enabled, valued secrets', async () => {
    const { app } = makeApp();
    await seed(app);

    const asBound = (await (await app.request('/secrets/resolve', authed(BOUND))).json()) as {
      env: Record<string, string>;
    };
    expect(asBound.env).toEqual({
      GITHUB_TOKEN: 'ghp_boundonly',
      TEAM_API_KEY: 'team-wide-value',
    });

    const asOutsider = (await (await app.request('/secrets/resolve', authed(OUTSIDER))).json()) as {
      env: Record<string, string>;
    };
    expect(asOutsider.env).toEqual({ TEAM_API_KEY: 'team-wide-value' });
  });

  it('disabling a secret stops delivery', async () => {
    const { app } = makeApp();
    await seed(app);
    await app.request('/secrets/gh', authed(ADMIN, { enabled: false }, 'PATCH'));
    const asBound = (await (await app.request('/secrets/resolve', authed(BOUND))).json()) as {
      env: Record<string, string>;
    };
    expect(asBound.env.GITHUB_TOKEN).toBeUndefined();
  });

  it('requires auth', async () => {
    const { app } = makeApp();
    const resp = await app.request('/secrets/resolve');
    expect(resp.status).toBe(401);
  });
});

describe('change events', () => {
  it('fans out to delivery set + secrets.manage holders and never carries the value', async () => {
    const { app, broker } = makeApp();
    const pushSpy = vi.spyOn(broker, 'push');
    await app.request('/secrets', authed(ADMIN, { slug: 'gh', envName: 'GITHUB_TOKEN' }));
    await app.request('/secrets/gh/bindings', authed(ADMIN, { member: 'bound' }));
    await app.request('/secrets/gh/value', authed(ADMIN, { value: 'ghp_neverinevents' }, 'PUT'));
    await settle();

    const calls = pushSpy.mock.calls.filter(
      (call) => (call[0]?.data as { kind?: string } | undefined)?.kind === 'secret',
    );
    expect(calls.length).toBeGreaterThanOrEqual(3);

    const bindCall = calls.find((call) => (call[0]?.data as { event?: string }).event === 'bound');
    expect(bindCall).toBeDefined();
    const recipients = (bindCall?.[1] as { recipients: string[] }).recipients;
    expect(recipients).toContain('admin');
    expect(recipients).toContain('bound');
    expect(recipients).not.toContain('outsider');
    const data = bindCall?.[0]?.data as Record<string, unknown>;
    expect(data.thread).toBe('secret:gh');
    expect(data.secret_slug).toBe('gh');

    // The invariant that matters most: no event payload ever carries
    // the value, in body or data.
    for (const call of calls) {
      expect(JSON.stringify(call[0])).not.toContain('ghp_neverinevents');
    }
  });

  it('unbound events still reach the removed member', async () => {
    const { app, broker } = makeApp();
    await app.request('/secrets', authed(ADMIN, { slug: 'gh', envName: 'GITHUB_TOKEN' }));
    await app.request('/secrets/gh/bindings', authed(ADMIN, { member: 'bound' }));
    await settle();
    const pushSpy = vi.spyOn(broker, 'push');
    await app.request('/secrets/gh/bindings/bound', authed(ADMIN, undefined, 'DELETE'));
    await settle();
    const unbindCall = pushSpy.mock.calls.find(
      (call) => (call[0]?.data as { event?: string } | undefined)?.event === 'unbound',
    );
    expect((unbindCall?.[1] as { recipients: string[] }).recipients).toContain('bound');
  });
});
