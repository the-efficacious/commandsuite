import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Permission } from 'csuite-sdk/types';
import { afterEach, describe, expect, it } from 'vitest';
import { type DatabaseSyncInstance, openDatabase } from '../../src/db.js';
import { LocalBlobStore } from '../../src/files/blob-store.js';
import {
  createSqliteFilesystemStore,
  type FilesystemStore,
  type ViewerContext,
} from '../../src/files/filesystem-store.js';

function viewer(name: string, permissions: Permission[] = []): ViewerContext {
  return { name, permissions };
}

describe('SqliteFilesystemStore', () => {
  const dirsToClean: string[] = [];
  const dbsToClose: DatabaseSyncInstance[] = [];

  afterEach(() => {
    for (const db of dbsToClose.splice(0)) {
      try {
        db.close();
      } catch {
        /* already closed */
      }
    }
    for (const dir of dirsToClean.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeStore(): FilesystemStore {
    const dir = mkdtempSync(join(tmpdir(), 'csuite-fs-test-'));
    dirsToClean.push(dir);
    const db = openDatabase(':memory:');
    dbsToClose.push(db);
    const blobs = new LocalBlobStore(dir);
    return createSqliteFilesystemStore({ db, blobs });
  }

  describe('writeFile', () => {
    it('auto-creates ancestor directories under the owner home', async () => {
      const store = makeStore();
      const alice = viewer('alice');
      const result = await store.writeFile({
        path: '/alice/uploads/report.pdf',
        mimeType: 'application/pdf',
        writer: alice,
        source: Buffer.from('report'),
      });
      expect(result.entry.kind).toBe('file');
      expect(result.entry.owner).toBe('alice');
      expect(store.stat('/alice', alice)?.kind).toBe('directory');
      expect(store.stat('/alice/uploads', alice)?.kind).toBe('directory');
    });

    it("forbids writing into someone else's home", async () => {
      const store = makeStore();
      await expect(
        store.writeFile({
          path: '/alice/hack.txt',
          mimeType: 'text/plain',
          writer: viewer('bob'),
          source: Buffer.from('hack'),
        }),
      ).rejects.toMatchObject({ code: 'forbidden' });
    });

    it('allows a director to write anywhere', async () => {
      const store = makeStore();
      const result = await store.writeFile({
        path: '/alice/from-director.txt',
        mimeType: 'text/plain',
        writer: viewer('diana', ['members.manage']),
        source: Buffer.from('hello'),
      });
      expect(result.entry.owner).toBe('alice');
      expect(result.entry.createdBy).toBe('diana');
    });

    it('errors on collision by default and succeeds with suffix', async () => {
      const store = makeStore();
      const alice = viewer('alice');
      await store.writeFile({
        path: '/alice/uploads/foo.pdf',
        mimeType: 'application/pdf',
        writer: alice,
        source: Buffer.from('v1'),
      });
      await expect(
        store.writeFile({
          path: '/alice/uploads/foo.pdf',
          mimeType: 'application/pdf',
          writer: alice,
          source: Buffer.from('v2'),
        }),
      ).rejects.toMatchObject({ code: 'exists' });

      const second = await store.writeFile({
        path: '/alice/uploads/foo.pdf',
        mimeType: 'application/pdf',
        writer: alice,
        source: Buffer.from('v2'),
        collision: 'suffix',
      });
      expect(second.renamed).toBe(true);
      expect(second.entry.path).toBe('/alice/uploads/foo-1.pdf');
    });

    it('overwrite strategy replaces hash and decrements prior blob', async () => {
      const store = makeStore();
      const alice = viewer('alice');
      const first = await store.writeFile({
        path: '/alice/a.txt',
        mimeType: 'text/plain',
        writer: alice,
        source: Buffer.from('one'),
      });
      const second = await store.writeFile({
        path: '/alice/a.txt',
        mimeType: 'text/plain',
        writer: alice,
        source: Buffer.from('two'),
        collision: 'overwrite',
      });
      expect(second.entry.path).toBe('/alice/a.txt');
      expect(second.entry.hash).not.toBe(first.entry.hash);
      expect(second.entry.size).toBe(3);
    });
  });

  describe('read permissions', () => {
    it('owner can stat + read own file', async () => {
      const store = makeStore();
      const alice = viewer('alice');
      await store.writeFile({
        path: '/alice/note.txt',
        mimeType: 'text/plain',
        writer: alice,
        source: Buffer.from('hello'),
      });
      const entry = store.stat('/alice/note.txt', alice);
      expect(entry?.name).toBe('note.txt');
      const { stream } = store.openReadStream('/alice/note.txt', alice);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      expect(Buffer.concat(chunks).toString('utf8')).toBe('hello');
    });

    it("bob without a grant cannot read alice's file", async () => {
      const store = makeStore();
      await store.writeFile({
        path: '/alice/secret.txt',
        mimeType: 'text/plain',
        writer: viewer('alice'),
        source: Buffer.from('secret'),
      });
      expect(() => store.stat('/alice/secret.txt', viewer('bob'))).toThrow(
        expect.objectContaining({ code: 'forbidden' }),
      );
    });

    it('bob with a grant can read but cannot list the containing directory', async () => {
      const store = makeStore();
      await store.writeFile({
        path: '/alice/shared.txt',
        mimeType: 'text/plain',
        writer: viewer('alice'),
        source: Buffer.from('for bob'),
      });
      store.grant('/alice/shared.txt', 'bob', 'msg-123');
      const bob = viewer('bob');
      expect(store.stat('/alice/shared.txt', bob)?.path).toBe('/alice/shared.txt');
      expect(() => store.list('/alice', bob)).toThrow(
        expect.objectContaining({ code: 'forbidden' }),
      );
    });

    it('directors see everything', async () => {
      const store = makeStore();
      await store.writeFile({
        path: '/alice/vault.txt',
        mimeType: 'text/plain',
        writer: viewer('alice'),
        source: Buffer.from('vault'),
      });
      const diana = viewer('diana', ['members.manage']);
      expect(store.stat('/alice/vault.txt', diana)?.size).toBe(5);
      expect(store.list('/alice', diana).map((e) => e.name)).toContain('vault.txt');
    });
  });

  describe('list', () => {
    it('lists root as per-owner homes (each slot sees only their own)', async () => {
      const store = makeStore();
      const alice = viewer('alice');
      const bob = viewer('bob');
      await store.writeFile({
        path: '/alice/a.txt',
        mimeType: 'text/plain',
        writer: alice,
        source: Buffer.from('a'),
      });
      await store.writeFile({
        path: '/bob/b.txt',
        mimeType: 'text/plain',
        writer: bob,
        source: Buffer.from('b'),
      });
      expect(store.list('/', alice).map((e) => e.name)).toEqual(['alice']);
      expect(store.list('/', bob).map((e) => e.name)).toEqual(['bob']);
      expect(
        store
          .list('/', viewer('diana', ['members.manage']))
          .map((e) => e.name)
          .sort(),
      ).toEqual(['alice', 'bob']);
    });

    it('lists children of a directory sorted dirs-first then alpha', async () => {
      const store = makeStore();
      const alice = viewer('alice');
      await store.writeFile({
        path: '/alice/z.txt',
        mimeType: 'text/plain',
        writer: alice,
        source: Buffer.from('z'),
      });
      store.mkdir('/alice/subdir', alice, { recursive: true });
      await store.writeFile({
        path: '/alice/a.txt',
        mimeType: 'text/plain',
        writer: alice,
        source: Buffer.from('a'),
      });
      const names = store.list('/alice', alice).map((e) => e.name);
      expect(names).toEqual(['subdir', 'a.txt', 'z.txt']);
    });
  });

  describe('remove', () => {
    it('deletes a file and drops the blob when the last reference goes away', async () => {
      const store = makeStore();
      const alice = viewer('alice');
      await store.writeFile({
        path: '/alice/gone.txt',
        mimeType: 'text/plain',
        writer: alice,
        source: Buffer.from('bye'),
      });
      await store.remove('/alice/gone.txt', alice);
      expect(store.stat('/alice/gone.txt', alice)).toBeNull();
    });

    it('refuses non-empty directory without recursive', async () => {
      const store = makeStore();
      const alice = viewer('alice');
      await store.writeFile({
        path: '/alice/nested/foo.txt',
        mimeType: 'text/plain',
        writer: alice,
        source: Buffer.from('foo'),
      });
      await expect(store.remove('/alice/nested', alice)).rejects.toMatchObject({
        code: 'not_empty',
      });
    });

    it('recursively deletes a directory tree', async () => {
      const store = makeStore();
      const alice = viewer('alice');
      await store.writeFile({
        path: '/alice/nested/deep/foo.txt',
        mimeType: 'text/plain',
        writer: alice,
        source: Buffer.from('foo'),
      });
      await store.writeFile({
        path: '/alice/nested/bar.txt',
        mimeType: 'text/plain',
        writer: alice,
        source: Buffer.from('bar'),
      });
      await store.remove('/alice/nested', alice, { recursive: true });
      expect(store.stat('/alice/nested/deep/foo.txt', alice)).toBeNull();
      expect(store.stat('/alice/nested', alice)).toBeNull();
      expect(store.stat('/alice', alice)?.kind).toBe('directory');
    });
  });

  describe('move', () => {
    it('renames a file in place', async () => {
      const store = makeStore();
      const alice = viewer('alice');
      await store.writeFile({
        path: '/alice/a.txt',
        mimeType: 'text/plain',
        writer: alice,
        source: Buffer.from('x'),
      });
      const moved = store.move('/alice/a.txt', '/alice/b.txt', alice);
      expect(moved.path).toBe('/alice/b.txt');
      expect(store.stat('/alice/a.txt', alice)).toBeNull();
    });

    it('refuses directory move in v1', async () => {
      const store = makeStore();
      const alice = viewer('alice');
      store.mkdir('/alice/dir', alice, { recursive: true });
      expect(() => store.move('/alice/dir', '/alice/dir2', alice)).toThrow(
        /directory move is not supported/,
      );
    });
  });

  describe('grants', () => {
    it('owner self-grants are no-ops', () => {
      const store = makeStore();
      store.grant('/alice/foo.txt', 'alice', 'msg-1');
      expect(store.hasGrant('/alice/foo.txt', 'alice')).toBe(false);
    });

    it('listShared returns the set of granted entries for the viewer', async () => {
      const store = makeStore();
      const alice = viewer('alice');
      await store.writeFile({
        path: '/alice/one.txt',
        mimeType: 'text/plain',
        writer: alice,
        source: Buffer.from('1'),
      });
      await store.writeFile({
        path: '/alice/two.txt',
        mimeType: 'text/plain',
        writer: alice,
        source: Buffer.from('2'),
      });
      store.grant('/alice/one.txt', 'bob', 'msg-1');
      store.grant('/alice/two.txt', 'bob', 'msg-2');
      // Extra duplicate grant via a different message — should dedupe.
      store.grant('/alice/one.txt', 'bob', 'msg-3');

      const shared = store
        .listShared(viewer('bob'))
        .map((e) => e.path)
        .sort();
      expect(shared).toEqual(['/alice/one.txt', '/alice/two.txt']);
    });
  });

  describe('ensureHome', () => {
    it('creates the slot home idempotently', () => {
      const store = makeStore();
      store.ensureHome('alice');
      store.ensureHome('alice');
      const entry = store.stat('/alice', viewer('alice'));
      expect(entry?.kind).toBe('directory');
      expect(entry?.owner).toBe('alice');
    });
  });
});
