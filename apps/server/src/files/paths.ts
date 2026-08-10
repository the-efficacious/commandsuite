/**
 * Path utilities for the csuite filesystem.
 *
 * Paths are absolute, Unix-like, with `/` as separator. Segments may
 * contain alphanumerics, dot, underscore, hyphen, and single spaces;
 * no `.`/`..` traversal; no leading/trailing whitespace; no empty
 * segments between slashes.
 *
 * ONE top-level scope holds the path tree: **member homes** at
 * `/<member-name>/`. The first path segment is the member name; that
 * name is also the row's `owner` value, and the read/write ACL is
 * "owner-only + admin + grant-holders".
 *
 * There used to be a second — an objective namespace at
 * `/objectives/<id>/`, owned by an objective's member set rather than
 * by a person — and it went with the objectives subsystem. Sharing is
 * grant-based now, which is the mechanism that survived: a grant names
 * a viewer and a path, so a shared file has a reader you can name.
 *
 * THAT TREE IS FROZEN, NOT ERASED, and `/objectives` is therefore a
 * RESERVED top-level segment. Rows written under it are still in
 * deployed databases carrying `owner = 'obj:<id>'`, a value no member
 * name can equal. When the namespace special case was deleted,
 * `ownerOf('/objectives/o-1/f.txt')` started returning `objectives` —
 * which IS a legal member name — so a member who happened to be called
 * that acquired read AND write over the whole legacy tree, while the
 * assignee it was created for correctly could not. A structural
 * boundary had quietly become a name-dependent one.
 *
 * So no member owns this segment by name, ever. `isFrozenLegacyPath`
 * is what `ownsPath` consults, and the consequence is stated rather
 * than hidden: a member named `objectives` has no home directory. That
 * is a worse outcome for one absurd name than for every deployed
 * database, which is the trade being made.
 *
 * The root `/` has no owner and is implicit (no DB row represents it).
 */

import { FsError } from './errors.js';

export const ROOT_PATH = '/' as const;

export const MAX_PATH_LENGTH = 1024;
export const MAX_SEGMENT_LENGTH = 255;

/**
 * The frozen legacy tree. Reserved: no member owns it by name.
 *
 * Kept as a constant rather than a literal because it is read in two
 * places — here and the ACL — and two spellings of a reserved word is
 * how a reservation stops being one.
 */
export const FROZEN_LEGACY_SEGMENT = 'objectives';

/**
 * Whether `path` sits in the frozen legacy tree, INCLUDING its bare
 * root. Reads reach it only through `members.manage` or an explicit
 * grant; writes only through `members.manage`.
 */
export function isFrozenLegacyPath(path: string): boolean {
  return splitPath(path)[0] === FROZEN_LEGACY_SEGMENT;
}

const SEGMENT_RE = /^[a-zA-Z0-9._\- ]+$/;

/**
 * Canonicalize a path: leading `/`, no trailing `/` (except root),
 * no empty segments, every segment validated. Throws `FsError` with
 * code `invalid_input` on any violation.
 */
export function normalizePath(raw: string): string {
  if (typeof raw !== 'string') throw new FsError('invalid_input', 'path must be a string');
  if (raw.length === 0) throw new FsError('invalid_input', 'path must not be empty');
  if (raw.length > MAX_PATH_LENGTH) {
    throw new FsError('invalid_input', `path exceeds max length ${MAX_PATH_LENGTH}`);
  }
  if (!raw.startsWith('/')) {
    throw new FsError('invalid_input', 'path must be absolute (start with /)');
  }

  const segments = raw.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) return ROOT_PATH;

  for (const seg of segments) {
    if (seg === '.' || seg === '..') {
      throw new FsError('invalid_input', `path traversal segment "${seg}" is not allowed`);
    }
    if (seg.length > MAX_SEGMENT_LENGTH) {
      throw new FsError(
        'invalid_input',
        `segment "${seg.slice(0, 32)}…" exceeds max length ${MAX_SEGMENT_LENGTH}`,
      );
    }
    if (seg.trim() !== seg) {
      throw new FsError('invalid_input', 'segments may not have leading/trailing whitespace');
    }
    if (!SEGMENT_RE.test(seg)) {
      throw new FsError('invalid_input', `invalid characters in segment "${seg}"`);
    }
  }
  return `/${segments.join('/')}`;
}

/** Segments of a normalized path. Root → []. */
export function splitPath(path: string): string[] {
  const normalized = normalizePath(path);
  if (normalized === ROOT_PATH) return [];
  return normalized.slice(1).split('/');
}

/**
 * Parent path. `/alice/uploads/foo.pdf` → `/alice/uploads`. `/alice` → `/`.
 * `/` → `/` (root has no parent).
 */
export function parentOf(path: string): string {
  const segments = splitPath(path);
  if (segments.length === 0) return ROOT_PATH;
  if (segments.length === 1) return ROOT_PATH;
  return `/${segments.slice(0, -1).join('/')}`;
}

/** Last segment. Root → ''. */
export function basenameOf(path: string): string {
  const segments = splitPath(path);
  if (segments.length === 0) return '';
  return segments[segments.length - 1] as string;
}

/**
 * Authoritative `owner` column value for the row at `path`.
 *
 *   `/alice/...`           → `'alice'`              (member-home scope)
 *   `/`                    → `null`                 (root; no DB row)
 *
 * Centralizing this here means write-time row creation and ACL checks
 * agree on the same scope tag without each call site re-deriving it.
 */
export function ownerOf(path: string): string | null {
  const segments = splitPath(path);
  if (segments.length === 0) return null;
  return segments[0] as string;
}

/**
 * Join parts into a single normalized path. Empty segments are
 * dropped. Useful for composing a home + subpath without worrying
 * about leading/trailing slashes. Throws if the composed path is
 * invalid (same rules as normalizePath).
 */
export function joinPath(...parts: string[]): string {
  const collected: string[] = [];
  for (const part of parts) {
    for (const seg of part.split('/')) {
      if (seg.length > 0) collected.push(seg);
    }
  }
  if (collected.length === 0) return ROOT_PATH;
  return normalizePath(`/${collected.join('/')}`);
}

/**
 * True when `ancestor` is an ancestor of `descendant` (or equal).
 * Both must already be normalized — pass the normalized form.
 */
export function isAncestorPath(ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  if (ancestor === ROOT_PATH) return true;
  return descendant.startsWith(`${ancestor}/`);
}

/**
 * Ensure a filename doesn't collide with an existing entry by
 * appending `-1`, `-2`, … before the extension. Caller passes a
 * `taken` predicate so we stay filesystem-agnostic (works against
 * a DB lookup or an in-memory set).
 */
export function dedupeBasename(name: string, taken: (candidate: string) => boolean): string {
  if (!taken(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 1; i < 10_000; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!taken(candidate)) return candidate;
  }
  throw new FsError('exists', `unable to find non-colliding name for "${name}"`);
}
