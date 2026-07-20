/**
 * Path utilities for the csuite filesystem.
 *
 * Paths are absolute, Unix-like, with `/` as separator. Segments may
 * contain alphanumerics, dot, underscore, hyphen, and single spaces;
 * no `.`/`..` traversal; no leading/trailing whitespace; no empty
 * segments between slashes.
 *
 * Two top-level scopes share the path tree:
 *   - **Member homes** at `/<member-name>/` — the original per-member
 *     scope. The first path segment is the member name; that name is
 *     also the row's `owner` value, and the read/write ACL is
 *     "owner-only + admin + grant-holders".
 *   - **Objective namespaces** at `/objectives/<id>/` — a per-objective
 *     scope owned not by an individual but by the objective's member
 *     set (originator + assignee + watchers). Rows under this prefix
 *     have `owner = 'obj:<id>'`; the ACL gate is "member of the
 *     objective + admin".
 *
 * The root `/` has no owner and is implicit (no DB row represents it).
 */

import { FsError } from './errors.js';

export const ROOT_PATH = '/' as const;

export const MAX_PATH_LENGTH = 1024;
export const MAX_SEGMENT_LENGTH = 255;

/**
 * Top-level segment for the objective-scope namespace. We use the
 * spelled-out word `objectives` in paths to keep them readable, while
 * the `owner` column carries the abbreviated `obj:<id>` form so it
 * matches the `obj:<id>` thread-key prefix used elsewhere.
 */
export const OBJECTIVE_NAMESPACE_SEGMENT = 'objectives';
export const OBJECTIVE_OWNER_PREFIX = 'obj:';

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
 *   `/objectives/foo/...`  → `'obj:foo'`            (objective scope)
 *   `/objectives`          → `'objectives'`         (the bare namespace dir;
 *                                                    no individual owns it)
 *   `/`                    → `null`                 (root; no DB row)
 *
 * Centralizing this here means write-time row creation and ACL checks
 * agree on the same scope tag without each call site re-deriving it.
 */
export function ownerOf(path: string): string | null {
  const segments = splitPath(path);
  if (segments.length === 0) return null;
  if (segments[0] === OBJECTIVE_NAMESPACE_SEGMENT) {
    if (segments.length === 1) return OBJECTIVE_NAMESPACE_SEGMENT;
    return `${OBJECTIVE_OWNER_PREFIX}${segments[1]}`;
  }
  return segments[0] as string;
}

/**
 * If `path` lives in the objective namespace, return its `id` and the
 * subpath under that objective's root. Returns `null` for any other
 * path (member homes, root, the bare `/objectives` parent).
 *
 *   `/objectives/foo/spec.pdf` → `{ id: 'foo', subpath: 'spec.pdf' }`
 *   `/objectives/foo`          → `{ id: 'foo', subpath: '' }`
 *   `/objectives`              → `null` (the bare namespace dir
 *                                        belongs to no specific objective)
 *   `/alice/...`               → `null`
 */
export function parseObjectiveNamespacePath(path: string): { id: string; subpath: string } | null {
  const segments = splitPath(path);
  if (segments.length < 2) return null;
  if (segments[0] !== OBJECTIVE_NAMESPACE_SEGMENT) return null;
  const id = segments[1] as string;
  const subpath = segments.slice(2).join('/');
  return { id, subpath };
}

/** Build a normalized path under an objective's namespace. */
export function objectiveNamespacePath(id: string, ...subpath: string[]): string {
  return joinPath(`/${OBJECTIVE_NAMESPACE_SEGMENT}`, id, ...subpath);
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
