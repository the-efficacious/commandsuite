/**
 * Variables endpoint tests — the properties that distinguish a variable
 * from a secret, and the ones that must NOT differ.
 *
 * The load-bearing assertions here are the negative ones. A variable is
 * defined by what does not happen to it: its value is not encrypted,
 * not write-only, and above all **not registered with the trace
 * redactor**. A test that only checked variables round-trip would pass
 * against an implementation that registered every one of them.
 *
 * Registration is checked through `redactSecrets` rather than by spying
 * on `registerSecretValues`, because the observable that matters is
 * whether the value survives in a captured body — a call that happened
 * is not the same claim as a value that got scrubbed.
 */

import {
  Broker,
  clearRegisteredSecretValues,
  createApp,
  createSqliteSecretsStore,
  createSqliteVariablesStore,
  createTokenStoreFromMembers,
  InMemoryEventLog,
  migrateIdentityToVariables,
  REDACTED,
  redactSecrets,
  SqliteSessionStore,
} from 'csuite-core';
import type { VariableSummary } from 'csuite-sdk/types';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../src/db.js';
import { kekFieldCipher, testKek } from '../src/kek.js';
import { createMemberStore, getKek, setKek } from '../src/members.js';
import { mockTeamStore } from './helpers/test-stores.js';

const ADMIN = 'csuite_test_admin_variable';
const BOUND = 'csuite_test_bound_variable';

const noopLog = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

async function makeApp() {
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
  ]);
  const db = openDatabase(':memory:');
  const sessions = new SqliteSessionStore(db);
  const tokens = await createTokenStoreFromMembers(db, members);
  const secrets = createSqliteSecretsStore(db, () => kekFieldCipher(getKek()));
  const variables = createSqliteVariablesStore(db);
  const { app } = createApp({
    broker,
    members,
    tokens,
    sessions,
    teamStore: mockTeamStore({ name: 'demo-team', context: '', permissionPresets: {} }),
    secrets,
    variables,
    version: '0.0.0',
    logger: noopLog,
  });
  return { app, broker, secrets, variables, db };
}

function authed(token: string, body?: unknown, method?: string): RequestInit {
  const init: RequestInit = {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  };
  init.method = method ?? (body !== undefined ? 'POST' : 'GET');
  if (body !== undefined) init.body = JSON.stringify(body);
  return init;
}

beforeAll(() => setKek(testKek()));
afterAll(() => setKek(null));
afterEach(() => clearRegisteredSecretValues());

describe('a variable value is readable, a secret value is not', () => {
  it('returns the value to a secrets.manage holder and withholds it from others', async () => {
    const { app } = await makeApp();
    await app.request(
      '/variables',
      authed(ADMIN, { slug: 'author-name', envName: 'GIT_AUTHOR_NAME' }),
    );
    await app.request('/variables/author-name/value', authed(ADMIN, { value: 'Turner' }, 'PUT'));

    const asAdmin = (await (await app.request('/variables/author-name', authed(ADMIN))).json()) as {
      variable: VariableSummary;
    };
    expect(asAdmin.variable.value).toBe('Turner');
    expect(asAdmin.variable.hasValue).toBe(true);

    const asMember = (await (
      await app.request('/variables/author-name', authed(BOUND))
    ).json()) as { variable: VariableSummary };
    expect(asMember.variable.value).toBeUndefined();
    // Still visible as configured — the metadata is not the secret part.
    expect(asMember.variable.hasValue).toBe(true);
  });

  it('never returns a secret value on the equivalent secrets route', async () => {
    const { app } = await makeApp();
    await app.request('/secrets', authed(ADMIN, { slug: 'gh', envName: 'GITHUB_TOKEN' }));
    await app.request('/secrets/gh/value', authed(ADMIN, { value: 'ghp_realsecret' }, 'PUT'));
    const body = (await (await app.request('/secrets/gh', authed(ADMIN))).json()) as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(body)).not.toContain('ghp_realsecret');
  });
});

describe('variables are never registered for redaction', () => {
  it('setting a variable value leaves it verbatim, while a secret value scrubs', async () => {
    const { app } = await makeApp();
    await app.request('/variables', authed(ADMIN, { slug: 'an', envName: 'GIT_AUTHOR_NAME' }));
    await app.request('/variables/an/value', authed(ADMIN, { value: 'Turner' }, 'PUT'));

    // The third registration site: PUT /secrets/:slug/value registers
    // immediately, in-process. The variables route must not.
    await app.request('/secrets', authed(ADMIN, { slug: 'gh', envName: 'GITHUB_TOKEN' }));
    await app.request('/secrets/gh/value', authed(ADMIN, { value: 'ghp_realsecret' }, 'PUT'));

    const captured = 'commit by Turner using ghp_realsecret';
    const redacted = redactSecrets(captured);

    expect(redacted).toContain('Turner');
    expect(redacted).not.toContain('ghp_realsecret');
    expect(redacted).toContain(REDACTED);
  });

  it('a variable value is absent from allDecryptedValues, which is what boot registers', async () => {
    const { secrets, variables } = await makeApp();
    const v = variables.create({ slug: 'an', envName: 'GIT_AUTHOR_NAME', creator: 'admin' });
    variables.setValue(v.id, 'Turner');
    const s = secrets.create({ slug: 'gh', envName: 'GITHUB_TOKEN', creator: 'admin' });
    secrets.setValue(s.id, 'ghp_realsecret');

    const registeredAtBoot = secrets.allDecryptedValues();
    expect(registeredAtBoot).toContain('ghp_realsecret');
    expect(registeredAtBoot).not.toContain('Turner');
  });
});

describe('the two stores share one environment namespace', () => {
  it('rejects a variable that collides with a secret for the same member', async () => {
    const { app } = await makeApp();
    await app.request('/secrets', authed(ADMIN, { slug: 's-name', envName: 'GIT_AUTHOR_NAME' }));
    await app.request('/secrets/s-name/bindings', authed(ADMIN, { member: 'bound' }));

    await app.request('/variables', authed(ADMIN, { slug: 'v-name', envName: 'GIT_AUTHOR_NAME' }));
    const collided = await app.request(
      '/variables/v-name/bindings',
      authed(ADMIN, { member: 'bound' }),
    );
    expect(collided.status).toBe(409);
    const body = (await collided.json()) as { error: string; code: string };
    expect(body.code).toBe('env_taken');
    expect(body.error).toContain('secret "s-name"');
  });

  it('rejects a secret that collides with a variable for the same member', async () => {
    const { app } = await makeApp();
    await app.request('/variables', authed(ADMIN, { slug: 'v-name', envName: 'GIT_AUTHOR_NAME' }));
    await app.request('/variables/v-name/bindings', authed(ADMIN, { member: 'bound' }));

    await app.request('/secrets', authed(ADMIN, { slug: 's-name', envName: 'GIT_AUTHOR_NAME' }));
    const collided = await app.request(
      '/secrets/s-name/bindings',
      authed(ADMIN, { member: 'bound' }),
    );
    expect(collided.status).toBe(409);
    expect(((await collided.json()) as { error: string }).error).toContain('variable "v-name"');
  });

  it('allows the same env name in both stores when they reach different members', async () => {
    const { app } = await makeApp();
    await app.request('/secrets', authed(ADMIN, { slug: 's-name', envName: 'GIT_AUTHOR_NAME' }));
    const boundSecret = await app.request(
      '/secrets/s-name/bindings',
      authed(ADMIN, { member: 'bound' }),
    );
    expect(boundSecret.status).toBe(200);

    await app.request('/variables', authed(ADMIN, { slug: 'v-name', envName: 'GIT_AUTHOR_NAME' }));
    const boundVariable = await app.request(
      '/variables/v-name/bindings',
      authed(ADMIN, { member: 'admin' }),
    );
    expect(boundVariable.status).toBe(200);
  });
});

describe('/secrets/resolve merges both stores and marks which are secret', () => {
  it('returns variables in env but omits them from secretEnvNames', async () => {
    const { app } = await makeApp();
    await app.request('/secrets', authed(ADMIN, { slug: 'gh', envName: 'GITHUB_TOKEN' }));
    await app.request('/secrets/gh/value', authed(ADMIN, { value: 'ghp_realsecret' }, 'PUT'));
    await app.request('/secrets/gh/bindings', authed(ADMIN, { member: 'bound' }));

    await app.request('/variables', authed(ADMIN, { slug: 'an', envName: 'GIT_AUTHOR_NAME' }));
    await app.request('/variables/an/value', authed(ADMIN, { value: 'Turner' }, 'PUT'));
    await app.request('/variables/an/bindings', authed(ADMIN, { member: 'bound' }));

    const resolved = (await (await app.request('/secrets/resolve', authed(BOUND))).json()) as {
      env: Record<string, string>;
      secretEnvNames: string[];
    };
    expect(resolved.env).toEqual({ GITHUB_TOKEN: 'ghp_realsecret', GIT_AUTHOR_NAME: 'Turner' });
    expect(resolved.secretEnvNames).toEqual(['GITHUB_TOKEN']);
    expect(resolved.secretEnvNames).not.toContain('GIT_AUTHOR_NAME');
  });
});

describe('identity migration', () => {
  const identitySeed = (secrets: Awaited<ReturnType<typeof makeApp>>['secrets']) => {
    const s = secrets.create({
      slug: 'turner-git-author-name',
      envName: 'GIT_AUTHOR_NAME',
      description: 'git identity',
      creator: 'admin',
    });
    secrets.setValue(s.id, 'Turner');
    secrets.bind(s.id, 'bound');
    return s;
  };

  it('moves identity to variables with value and bindings intact', async () => {
    const { db, secrets, variables } = await makeApp();
    identitySeed(secrets);

    const result = migrateIdentityToVariables(
      db,
      () => kekFieldCipher(getKek()),
      secrets,
      variables,
      noopLog,
    );

    expect(result.migrated).toEqual(['turner-git-author-name']);
    expect(secrets.getBySlug('turner-git-author-name')).toBeNull();
    const moved = variables.getBySlug('turner-git-author-name');
    expect(moved).not.toBeNull();
    if (!moved) throw new Error('unreachable');
    expect(variables.getValue(moved.id)).toBe('Turner');
    expect(variables.listBindings(moved.id)).toEqual(['bound']);
    expect(moved.envName).toBe('GIT_AUTHOR_NAME');
  });

  it('is idempotent — a second run moves nothing and breaks nothing', async () => {
    const { db, secrets, variables } = await makeApp();
    identitySeed(secrets);
    migrateIdentityToVariables(db, () => kekFieldCipher(getKek()), secrets, variables, noopLog);
    const second = migrateIdentityToVariables(
      db,
      () => kekFieldCipher(getKek()),
      secrets,
      variables,
      noopLog,
    );
    expect(second.migrated).toEqual([]);
    expect(second.noop).toBe(true);
    const moved = variables.getBySlug('turner-git-author-name');
    if (!moved) throw new Error('unreachable');
    expect(variables.getValue(moved.id)).toBe('Turner');
  });

  it('leaves a non-identity secret alone', async () => {
    const { db, secrets, variables } = await makeApp();
    const gh = secrets.create({ slug: 'gh', envName: 'GITHUB_TOKEN', creator: 'admin' });
    secrets.setValue(gh.id, 'ghp_realsecret');
    secrets.bind(gh.id, 'bound');

    migrateIdentityToVariables(db, () => kekFieldCipher(getKek()), secrets, variables, noopLog);

    expect(secrets.getBySlug('gh')).not.toBeNull();
    expect(variables.getBySlug('gh')).toBeNull();
    expect(secrets.allDecryptedValues()).toContain('ghp_realsecret');
  });

  it('migrates an identity row bound to nobody, because it is registered anyway', async () => {
    // Found on the live team database: exactly one identity secret had
    // no binding. Reading values through `resolveFor` (per-member)
    // could not recover it, so it stayed a secret — and
    // `allDecryptedValues()` registers every stored value regardless of
    // binding, so that one row went on scrubbing that member's name
    // from EVERY member's captured bodies. "Reaches no runner" is not
    // the same as "is not registered".
    const { db, secrets, variables } = await makeApp();
    const s = secrets.create({
      slug: 'orphan-git-author-name',
      envName: 'GIT_AUTHOR_NAME',
      creator: 'admin',
    });
    secrets.setValue(s.id, 'Nobody');
    expect(secrets.allDecryptedValues()).toContain('Nobody');

    const result = migrateIdentityToVariables(
      db,
      () => kekFieldCipher(getKek()),
      secrets,
      variables,
      noopLog,
    );

    expect(result.migrated).toEqual(['orphan-git-author-name']);
    expect(secrets.allDecryptedValues()).not.toContain('Nobody');
    const moved = variables.getBySlug('orphan-git-author-name');
    if (!moved) throw new Error('unreachable');
    expect(variables.getValue(moved.id)).toBe('Nobody');
    expect(variables.listBindings(moved.id)).toEqual([]);
  });

  it('reports a row it cannot move rather than dropping it silently', async () => {
    const { db, secrets, variables } = await makeApp();
    // A row with no stored value at all: nothing to migrate, and the
    // reason is named rather than the row vanishing from the report.
    secrets.create({
      slug: 'valueless-git-author-name',
      envName: 'GIT_AUTHOR_NAME',
      creator: 'admin',
    });

    const result = migrateIdentityToVariables(
      db,
      () => kekFieldCipher(getKek()),
      secrets,
      variables,
      noopLog,
    );

    expect(result.migrated).toEqual([]);
    expect(result.skipped).toEqual([
      { slug: 'valueless-git-author-name', reason: 'no stored value' },
    ]);
    expect(secrets.getBySlug('valueless-git-author-name')).not.toBeNull();
  });

  it('rolls back whole when a row fails mid-migration, leaving nothing half-moved', async () => {
    // Criterion 3 says a half-migrated state is the outcome to refuse:
    // a secret deleted before its variable exists loses a value that
    // cannot be regenerated, and a variable created without deleting
    // the secret leaves the member resolving one env name from both
    // stores — which `resolveFor` then refuses, breaking every runner
    // start. That was a decision stated before building, and a decision
    // settled in argument but unpinned in code is one the next edit
    // reverses silently.
    const { db, secrets, variables } = await makeApp();
    for (const [slug, env] of [
      ['a-git-author-name', 'GIT_AUTHOR_NAME'],
      ['b-git-author-email', 'GIT_AUTHOR_EMAIL'],
    ] as const) {
      const s = secrets.create({ slug, envName: env, creator: 'admin' });
      secrets.setValue(s.id, `value-for-${slug}`);
      secrets.bind(s.id, 'bound');
    }

    // Fail the SECOND variable insert, so the first row has already been
    // written and deleted when the error lands — the exact shape that
    // would leave the batch half-applied without a transaction.
    let inserts = 0;
    const failing = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== 'prepare') {
          // Bind natives to the real handle — reflecting through the
          // proxy hands methods a Proxy `this`, and DatabaseSync
          // natives throw "Illegal invocation" on that.
          const v = Reflect.get(target, prop, receiver);
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        }
        return (sql: string) => {
          const stmt = target.prepare(sql);
          if (!sql.includes('INSERT INTO variables')) return stmt;
          return new Proxy(stmt, {
            get(st, p, r) {
              if (p !== 'run') return Reflect.get(st, p, r);
              return (...args: unknown[]) => {
                inserts += 1;
                if (inserts === 2) throw new Error('disk full');
                return (st.run as (...a: unknown[]) => unknown)(...args);
              };
            },
          });
        };
      },
    });

    const result = migrateIdentityToVariables(
      failing as unknown as typeof db,
      () => kekFieldCipher(getKek()),
      secrets,
      variables,
      noopLog,
    );

    expect(result.migrated).toEqual([]);
    // Both secrets are exactly where they were — including the first,
    // which had already been inserted and deleted inside the transaction.
    expect(secrets.getBySlug('a-git-author-name')).not.toBeNull();
    expect(secrets.getBySlug('b-git-author-email')).not.toBeNull();
    expect(variables.getBySlug('a-git-author-name')).toBeNull();
    expect(variables.getBySlug('b-git-author-email')).toBeNull();
    // The values survived, which is the part that cannot be regenerated.
    expect(secrets.allDecryptedValues()).toContain('value-for-a-git-author-name');
    expect(secrets.allDecryptedValues()).toContain('value-for-b-git-author-email');
    // And it said so rather than reporting a clean run.
    expect(noopLog.warn).toHaveBeenCalledWith(
      'identity migration rolled back; identity remains registered for redaction',
      expect.objectContaining({ error: 'disk full' }),
    );
  });

  it('after migration the identity value is no longer registered at boot', async () => {
    const { db, secrets, variables } = await makeApp();
    identitySeed(secrets);
    expect(secrets.allDecryptedValues()).toContain('Turner');

    migrateIdentityToVariables(db, () => kekFieldCipher(getKek()), secrets, variables, noopLog);

    expect(secrets.allDecryptedValues()).not.toContain('Turner');
  });
});
