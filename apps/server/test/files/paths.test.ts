import { describe, expect, it } from 'vitest';
import { FsError } from '../../src/files/errors.js';
import {
  basenameOf,
  dedupeBasename,
  isAncestorPath,
  joinPath,
  normalizePath,
  ownerOf,
  parentOf,
  ROOT_PATH,
  splitPath,
} from '../../src/files/paths.js';

describe('paths', () => {
  describe('normalizePath', () => {
    it('returns root for "/"', () => {
      expect(normalizePath('/')).toBe('/');
    });

    it('strips duplicate slashes and trailing slash', () => {
      expect(normalizePath('//alice//uploads//')).toBe('/alice/uploads');
    });

    it('rejects relative paths', () => {
      expect(() => normalizePath('alice/foo')).toThrow(FsError);
    });

    it('rejects traversal segments', () => {
      expect(() => normalizePath('/alice/../bob')).toThrow(/traversal/);
      expect(() => normalizePath('/alice/./foo')).toThrow(/traversal/);
    });

    it('rejects bogus characters', () => {
      expect(() => normalizePath('/alice/foo\n')).toThrow(FsError);
      expect(() => normalizePath('/alice/foo*bar')).toThrow(FsError);
    });

    it('rejects empty segments with surrounding whitespace', () => {
      expect(() => normalizePath('/alice/ foo')).toThrow(FsError);
      expect(() => normalizePath('/alice/foo ')).toThrow(FsError);
    });

    it('accepts spaces inside segments', () => {
      expect(normalizePath('/alice/my report.pdf')).toBe('/alice/my report.pdf');
    });
  });

  describe('parentOf / basenameOf / ownerOf', () => {
    it('computes parent for nested paths', () => {
      expect(parentOf('/alice/uploads/foo.pdf')).toBe('/alice/uploads');
      expect(parentOf('/alice')).toBe('/');
      expect(parentOf('/')).toBe('/');
    });

    it('extracts basename', () => {
      expect(basenameOf('/alice/uploads/foo.pdf')).toBe('foo.pdf');
      expect(basenameOf('/alice')).toBe('alice');
      expect(basenameOf('/')).toBe('');
    });

    it('extracts the owning slot from the first segment', () => {
      expect(ownerOf('/alice/uploads/foo.pdf')).toBe('alice');
      expect(ownerOf('/alice')).toBe('alice');
      expect(ownerOf('/')).toBeNull();
    });
  });

  describe('splitPath / joinPath', () => {
    it('splits into segments', () => {
      expect(splitPath('/alice/uploads/foo.pdf')).toEqual(['alice', 'uploads', 'foo.pdf']);
      expect(splitPath('/')).toEqual([]);
    });

    it('joins parts and normalizes', () => {
      expect(joinPath('/alice', 'uploads', 'foo.pdf')).toBe('/alice/uploads/foo.pdf');
      expect(joinPath('alice', 'uploads/')).toBe('/alice/uploads');
      expect(joinPath('/')).toBe('/');
    });
  });

  describe('isAncestorPath', () => {
    it('says root is an ancestor of anything', () => {
      expect(isAncestorPath(ROOT_PATH, '/alice/foo')).toBe(true);
    });

    it('detects direct ancestry', () => {
      expect(isAncestorPath('/alice', '/alice/uploads')).toBe(true);
      expect(isAncestorPath('/alice', '/alice/uploads/foo.pdf')).toBe(true);
    });

    it('rejects siblings and prefix-lookalikes', () => {
      expect(isAncestorPath('/alice', '/alicepants')).toBe(false);
      expect(isAncestorPath('/alice/uploads', '/alice/other')).toBe(false);
    });
  });

  describe('dedupeBasename', () => {
    it('returns the original when the name is free', () => {
      expect(dedupeBasename('foo.pdf', () => false)).toBe('foo.pdf');
    });

    it('appends -1 / -2 before the extension on collisions', () => {
      const taken = new Set(['foo.pdf', 'foo-1.pdf']);
      expect(dedupeBasename('foo.pdf', (c) => taken.has(c))).toBe('foo-2.pdf');
    });

    it('handles no-extension names', () => {
      const taken = new Set(['foo']);
      expect(dedupeBasename('foo', (c) => taken.has(c))).toBe('foo-1');
    });
  });
});
