/**
 * The probe-engine fixture: a whole server with an annex, a curator, a
 * check registry, an inbound webhook endpoint and an injected clock and
 * `fetch`.
 *
 * WHOLE, and deliberately. The probe engine's claims are end-to-end
 * claims — a signed delivery reaches the inbox, is verified, matches a
 * member's predicate, becomes an observation, discharges the thing it
 * was armed on, and produces exactly one line in one member's album —
 * and every seam in that chain is a place a defect can hide. A fixture
 * that stubbed the inbox would prove the engine works against a stub.
 *
 * The two injections are the clock and `fetch`. Both are real options
 * on `createApp`, not test-only hooks: `now` has been one since the
 * dispatcher, and `probeFetch` is where a deployment puts an egress
 * proxy. The suite drives them because a poll's security pins cannot be
 * asserted against a socket.
 */

import { createHmac } from 'node:crypto';
import { Broker, InMemoryEventLog } from 'csuite-core';
import type { Message, SpineCheck } from 'csuite-sdk/types';
import { vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { openDatabase } from '../../src/db.js';
import { testKek } from '../../src/kek.js';
import { createMemberStore, setKek } from '../../src/members.js';
import { createSqliteNotificationsStore } from '../../src/notifications/index.js';
import { createSqliteSecretsStore } from '../../src/secrets.js';
import { SessionStore } from '../../src/sessions.js';
import {
  createAnnexWritePath,
  createSqliteCheckStore,
  createSqliteCuratorStore,
} from '../../src/spine/index.js';
import { createTokenStoreFromMembers } from '../../src/tokens.js';
import { mockTeamStore } from './test-stores.js';

export const LEA = 'csuite_probe_lea_token';
export const RUNE = 'csuite_probe_rune_token';
export const ANDREWJON = 'csuite_probe_andrewjon_token';

export const TOKENS: Record<string, string> = {
  lea: LEA,
  rune: RUNE,
  andrewjon: ANDREWJON,
};

/** The endpoint's signing secret, and the only thing that makes a delivery genuine. */
export const HOOK_SECRET = 'probe-hook-signing-secret';
export const HOOK_SLUG = 'ci';

export interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

/** A scripted `fetch`: one response per call, and every call recorded. */
export function scriptedFetch(responses: (() => Response)[]): {
  impl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  let n = 0;
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const next = responses[Math.min(n, responses.length - 1)];
    n += 1;
    if (next === undefined) throw new Error('scripted fetch ran out of responses');
    return next();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function makeProbeApp(options: { fetchImpl?: typeof fetch } = {}) {
  setKek(testKek());
  const clock = { ms: 1_700_000_000_000 };
  const now = () => clock.ms;
  let n = 0;
  const broker = new Broker({
    eventLog: new InMemoryEventLog(),
    now,
    idFactory: () => `msg-${++n}`,
  });
  const members = createMemberStore([
    {
      name: 'lea',
      role: { title: 'engineer', description: '' },
      permissions: ['spine.author', 'notifications.manage'],
      token: LEA,
    },
    {
      name: 'rune',
      role: { title: 'engineer', description: '' },
      permissions: ['spine.author'],
      token: RUNE,
    },
    {
      name: 'andrewjon',
      role: { title: 'director', description: '' },
      permissions: ['spine.author', 'members.manage'],
      token: ANDREWJON,
    },
  ]);
  broker.seedMembers(members.members());
  const db = openDatabase(':memory:');
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const spine = createAnnexWritePath({ db, logger });
  const spineCurator = createSqliteCuratorStore(db);
  const spineChecks = createSqliteCheckStore(db);
  const notifications = createSqliteNotificationsStore(db);
  const secrets = createSqliteSecretsStore(db);
  const created = createApp({
    broker,
    members,
    tokens: createTokenStoreFromMembers(db, members),
    sessions: new SessionStore(db),
    teamStore: mockTeamStore({ name: 'probe-team', context: '', permissionPresets: {} }),
    spine,
    spineCurator,
    spineChecks,
    notifications,
    secrets,
    ...(options.fetchImpl !== undefined ? { probeFetch: options.fetchImpl } : {}),
    now,
    version: '0.0.0',
    logger,
  });
  if (created.probes === undefined)
    throw new Error('fixture wired a check store but got no engine');
  if (created.curator === undefined) throw new Error('fixture wired a curator store but got none');

  const endpoint = notifications.create({
    slug: HOOK_SLUG,
    displayName: 'CI',
    auth: { kind: 'hmac-sha256' },
    targets: [{ member: 'rune' }],
    creator: 'lea',
    now: clock.ms,
  });
  notifications.setSecret(endpoint.id, HOOK_SECRET, clock.ms);

  /**
   * Attach a live subscriber. Class-1 leases are granted on CONFIRMED
   * delivery, so a member with no sink is a member nothing is confirmed
   * to — that is the floor, not a fixture detail to route around.
   */
  const sinkFor = (name: string) => {
    const messages: Message[] = [];
    const close = broker.subscribe(
      name,
      async (message) => {
        messages.push(message);
      },
      { name },
    );
    return {
      name,
      messages,
      get injections() {
        return messages.filter(
          (m) => (m.data as { kind?: string } | undefined)?.kind === 'spine_injection',
        );
      },
      close,
    };
  };

  return {
    app: created.app,
    probes: created.probes,
    curator: created.curator,
    annex: spine.store,
    checks: spineChecks,
    secrets,
    notifications,
    endpoint,
    broker,
    members,
    db,
    clock,
    logger,
    sinkFor,
  };
}

export type ProbeApp = ReturnType<typeof makeProbeApp>;

export function authed(token: string, body?: unknown, method?: string): RequestInit {
  const init: RequestInit = {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  };
  init.method = method ?? (body !== undefined ? 'POST' : 'GET');
  if (body !== undefined) init.body = JSON.stringify(body);
  return init;
}

/** A genuine, signed delivery — the only kind the inbox lets through. */
export function signedHook(body: string, secret = HOOK_SECRET): RequestInit {
  const sig = `sha256=${createHmac('sha256', secret).update(Buffer.from(body)).digest('hex')}`;
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig },
    body,
  };
}

/** Flush the fire-and-forget promises the broker fanout leaves behind. */
export const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

export function onlyArmed(checks: SpineCheck[]): SpineCheck[] {
  return checks.filter((c) => c.state === 'armed');
}
