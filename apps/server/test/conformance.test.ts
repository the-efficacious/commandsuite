/**
 * The Node binding run of `csuite-core/conformance` — every driver and
 * port this server supplies, exercised through the shared contract
 * suites. This is what makes the kit load-bearing upstream: a change
 * to a store or a port that the reference implementations no longer
 * satisfy fails HERE, in the same CI that gates the change.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Broker,
  createApp,
  createTokenStoreFromMembers,
  InMemoryEventLog,
  SqliteSessionStore,
} from 'csuite-core';
import {
  blobStoreConformance,
  brokerAppConformance,
  fieldCipherConformance,
  sqlDriverConformance,
} from 'csuite-core/conformance';
import { afterAll } from 'vitest';
import { openDatabase } from '../src/db.js';
import { LocalBlobStore } from '../src/files/index.js';
import { kekFieldCipher, testKek } from '../src/kek.js';
import { createMemberStore } from '../src/members.js';
import { silentLogger } from './helpers/logger.js';
import { mockTeamStore } from './helpers/test-stores.js';

const OPERATOR_TOKEN = 'csuite_conformance_operator_token';

const dirsToClean: string[] = [];
afterAll(() => {
  for (const dir of dirsToClean.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

sqlDriverConformance(() => openDatabase(':memory:'));

blobStoreConformance(() => {
  const dir = mkdtempSync(join(tmpdir(), 'csuite-blob-conformance-'));
  dirsToClean.push(dir);
  return new LocalBlobStore(dir);
});

const KEK = testKek();
fieldCipherConformance(() => {
  const cipher = kekFieldCipher(KEK);
  if (cipher === null) throw new Error('kekFieldCipher returned null for a real key');
  return cipher;
});

brokerAppConformance(async () => {
  const broker = new Broker({ eventLog: new InMemoryEventLog() });
  const members = createMemberStore([
    {
      name: 'operator-1',
      role: { title: 'operator', description: '' },
      permissions: ['activity.read'],
      token: OPERATOR_TOKEN,
    },
  ]);
  broker.seedMembers(members.members());
  const db = openDatabase(':memory:');
  const created = createApp({
    broker,
    members,
    tokens: await createTokenStoreFromMembers(db, members),
    sessions: new SqliteSessionStore(db),
    teamStore: mockTeamStore({
      name: 'conformance-team',
      context: '',
      permissionPresets: {},
    }),
    version: '0.0.0',
    logger: silentLogger(),
  });
  return { created, bearerToken: OPERATOR_TOKEN, memberName: 'operator-1' };
});
