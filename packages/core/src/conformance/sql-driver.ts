import { describe, expect, it } from 'vitest';
import { runInTransaction, type SqlDriver } from '../sql-driver.js';

/**
 * Behavioral contract for a `SqlDriver`.
 *
 * `makeDriver` must return a driver over a FRESH, EMPTY database on
 * every call. The suite asserts the exact subset the stores rely on:
 * synchronous exec/prepare, positional `?` binding, `get`/`all`/`run`
 * result shapes, the JSON1 functions, and UNIQUE-conflict errors
 * surfacing as thrown exceptions.
 */
export function sqlDriverConformance(makeDriver: () => SqlDriver): void {
  describe('SqlDriver conformance', () => {
    it('execs DDL and round-trips rows through prepare/run/get/all', () => {
      const db = makeDriver();
      db.exec('CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER NOT NULL, blob_v BLOB)');
      const insert = db.prepare('INSERT INTO t (id, n, blob_v) VALUES (?, ?, ?)');
      const r1 = insert.run('a', 1, null);
      expect(Number(r1.changes)).toBe(1);
      insert.run('b', 2, new Uint8Array([1, 2, 3]));

      const get = db.prepare('SELECT id, n FROM t WHERE id = ?');
      expect(get.get('missing')).toBeUndefined();
      expect(get.get('a')).toMatchObject({ id: 'a', n: 1 });

      const all = db.prepare('SELECT id FROM t ORDER BY n ASC').all() as Array<{ id: string }>;
      expect(all.map((r) => r.id)).toEqual(['a', 'b']);
    });

    it('binds null / number / bigint-safe integers / string positionally', () => {
      const db = makeDriver();
      db.exec('CREATE TABLE v (a, b, c, d)');
      db.prepare('INSERT INTO v (a, b, c, d) VALUES (?, ?, ?, ?)').run(
        null,
        4.5,
        Number.MAX_SAFE_INTEGER,
        'text',
      );
      const row = db.prepare('SELECT a, b, c, d FROM v').get() as Record<string, unknown>;
      expect(row.a).toBeNull();
      expect(row.b).toBe(4.5);
      expect(row.c).toBe(Number.MAX_SAFE_INTEGER);
      expect(row.d).toBe('text');
    });

    it('supports the JSON1 functions the stores query with', () => {
      const db = makeDriver();
      db.exec('CREATE TABLE j (data TEXT NOT NULL)');
      db.prepare('INSERT INTO j (data) VALUES (?)').run(JSON.stringify({ thread: 'chan:general' }));
      const row = db.prepare(`SELECT json_extract(data, '$.thread') AS thread FROM j`).get() as {
        thread: string;
      };
      expect(row.thread).toBe('chan:general');
    });

    it('supports json_each, which the event feed scopes rows with', () => {
      const db = makeDriver();
      db.exec('CREATE TABLE r (id TEXT NOT NULL, recipients TEXT)');
      const insert = db.prepare('INSERT INTO r (id, recipients) VALUES (?, ?)');
      insert.run('scoped', JSON.stringify(['alice', 'bob']));
      insert.run('broadcast', null);
      const stmt = db.prepare(
        `SELECT id FROM r
          WHERE recipients IS NULL
             OR EXISTS (SELECT 1 FROM json_each(r.recipients) WHERE value = ?)
          ORDER BY id`,
      );
      expect((stmt.all('bob') as Array<{ id: string }>).map((row) => row.id)).toEqual([
        'broadcast',
        'scoped',
      ]);
      expect((stmt.all('carol') as Array<{ id: string }>).map((row) => row.id)).toEqual([
        'broadcast',
      ]);
    });

    it('surfaces UNIQUE violations as thrown errors, not silent no-ops', () => {
      const db = makeDriver();
      db.exec('CREATE TABLE u (id TEXT PRIMARY KEY)');
      const insert = db.prepare('INSERT INTO u (id) VALUES (?)');
      insert.run('same');
      expect(() => insert.run('same')).toThrow();
    });

    it('commits and rolls back through runInTransaction', () => {
      const db = makeDriver();
      db.exec('CREATE TABLE tx (id TEXT PRIMARY KEY)');
      const insert = db.prepare('INSERT INTO tx (id) VALUES (?)');
      runInTransaction(db, () => {
        insert.run('kept');
      });
      expect(() =>
        runInTransaction(db, () => {
          insert.run('discarded');
          throw new Error('abort');
        }),
      ).toThrow('abort');
      const ids = db.prepare('SELECT id FROM tx').all() as Array<{ id: string }>;
      expect(ids).toEqual([{ id: 'kept' }]);
    });

    it('reports lastInsertRowid for AUTOINCREMENT tables', () => {
      const db = makeDriver();
      db.exec('CREATE TABLE ai (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)');
      const r = db.prepare('INSERT INTO ai (v) VALUES (?)').run('x');
      expect(Number(r.lastInsertRowid)).toBeGreaterThan(0);
    });
  });
}
