/**
 * Runner-side codex rollout reader — the rollout-primary capture source.
 *
 * Codex appends every turn of a thread to a newline-delimited JSON
 * rollout at `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`.
 * Because the runner gives codex an EPHEMERAL, per-run `CODEX_HOME`, that
 * `sessions/` tree contains exactly this run's rollout(s) — the root
 * thread AND every subagent thread codex dispatches, each in its own
 * file. We tail ALL of them here and feed each complete line to a pure
 * `RolloutParser`, which maps turns to `ActivityEvent`s (llm_exchange /
 * tool_action / user_prompt) on the capture host's uploader. This is the
 * codex analogue of the Claude `TranscriptReader`; the app-server stream
 * stays presence/busy-only.
 *
 * ONE PARSER PER FILE. A parser accumulates open-turn state, and codex
 * threads run concurrently — interleaving two threads' lines into one
 * parser would corrupt turn accumulation. So each rollout file gets its
 * own parser, stamped with that thread's `querySource`
 * (`codex_main_thread` vs `codex_subagent:<id8>`) so subagent turns are
 * distinguishable in the feed — matching how the gen_ai / raw layers
 * already attribute threads (see `bundle-reader.ts`).
 *
 * The reader mirrors the transcript reader's guarantees:
 *   - DEFENSIVE: never throws on a truncated/garbage line — the parser
 *     logs + skips. A missing file (before codex creates it) is a no-op.
 *   - RESUMABLE: a per-file byte offset advanced only past COMPLETE lines
 *     (up to the last newline); a partial trailing line waits for the
 *     next drain.
 *   - LIVE: `fs.watch` per file (low latency) + a ~300ms poll fallback
 *     that also DISCOVERS new subagent files, funnelled into a single
 *     serialized `drainAll()`.
 *
 * LIFECYCLE: the codex adapter removes the ephemeral `CODEX_HOME` at
 * teardown, which deletes the rollouts. So `close()` is async and does a
 * FINAL discover + drain + `parser.flush()` (every tracked file) BEFORE
 * returning — the adapter awaits it before removing the dir, so the last
 * turn of every thread is never lost to the rm.
 */

import { type FSWatcher, readdirSync, statSync, watch } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { ActivityEvent } from 'csuite-sdk/types';
import { createRolloutParser, type RolloutParser } from './rollout-parser.js';

export interface RolloutReaderOptions {
  /**
   * The codex `sessions/` root to scan — `<CODEX_HOME>/sessions`. The
   * reader recursively looks for `rollout-*.jsonl` under it and tails
   * every match.
   */
  sessionsDir: string;
  /**
   * The root thread's session/thread id (the uuid codex embeds in the
   * rollout filename), used to attribute the root file as
   * `codex_main_thread` and every other file as a subagent. Optional
   * because it isn't known until codex's `thread/start` returns; until
   * then a discovered file is treated as the main thread (the root file
   * is the first to appear, so it's labelled correctly even without it).
   */
  getSessionId?: () => string | null | undefined;
  /** Sink for the mapped activity events (the capture host's uploader). */
  enqueue: (event: ActivityEvent) => void;
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
  /** Poll interval in ms for the discover + drain fallback. Default 300. */
  pollMs?: number;
  /**
   * How to treat rollout files that already exist when the reader
   * attaches. `'track'` (default, the historical behavior) tails them
   * from byte 0 — correct for a per-run ephemeral sessions dir, where
   * any file present at attach belongs to this run. `'ignore'` skips
   * them entirely (no parser, no watcher) — required for a DURABLE
   * sessions dir, where files present at attach are prior runs' history
   * that was already captured when it was written. Files that appear
   * AFTER attach are always tracked from 0 in both modes.
   */
  preexisting?: 'track' | 'ignore';
  /**
   * With `preexisting: 'ignore'`, the one pre-existing file whose name
   * carries this thread id (the thread being `thread/resume`d) is
   * tailed anyway — starting at its CURRENT size, so only turns
   * appended by the resumed run are captured, never the already-
   * uploaded history. Safe because the reader attaches before the
   * resume handshake, so codex can't have appended yet.
   */
  resumeThreadId?: string;
}

export interface RolloutReader {
  /**
   * Stop watching, do a FINAL discover + drain of any bytes written
   * since the last one across every tracked file, flush each parser's
   * open turn, and release resources. Async and idempotent — the adapter
   * awaits this BEFORE removing the ephemeral CODEX_HOME so no thread's
   * last turn is lost to the rm.
   */
  close(): Promise<void>;
}

const DEFAULT_POLL_MS = 300;
/** LF byte — line delimiter in the JSONL rollout. */
const NEWLINE = 0x0a;
const ROLLOUT_RE = /^rollout-.*\.jsonl$/;
/** Trailing codex thread/session uuid in a rollout filename. */
const THREAD_ID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The codex thread uuid embedded in a rollout filename, if present. */
function threadIdOf(name: string): string | null {
  return THREAD_ID_RE.exec(name)?.[1] ?? null;
}

/**
 * Attribute a rollout file to a thread: `codex_main_thread` when its
 * name carries the root id (or the root id isn't known yet), else
 * `codex_subagent:<id8>`. Mirrors the main-vs-subagent decision in
 * `bundle-reader.ts` — the root is matched on the FULL id, and only the
 * subagent label is abbreviated to 8 chars.
 */
function sourceFor(name: string, rootId: string | null | undefined): string {
  if (rootId && name.includes(rootId)) return 'codex_main_thread';
  if (rootId == null) return 'codex_main_thread';
  const tid = threadIdOf(name);
  return `codex_subagent:${tid ? tid.slice(0, 8) : 'unknown'}`;
}

interface TrackedFile {
  /** Bytes consumed so far — always aligned to a newline boundary. */
  offset: number;
  /** This thread's parser (turn state is per-file). */
  parser: RolloutParser;
  /** Thread attribution stamped on this file's events. */
  source: string;
  watcher: FSWatcher | null;
}

export function attachRolloutReader(options: RolloutReaderOptions): RolloutReader {
  const log =
    options.log ??
    ((msg: string, ctx: Record<string, unknown> = {}): void => {
      const record = { ts: new Date().toISOString(), component: 'rollout-reader', msg, ...ctx };
      process.stderr.write(`${JSON.stringify(record)}\n`);
    });
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;

  // path → tracker. Each rollout file (thread) gets its own parser.
  const tracked = new Map<string, TrackedFile>();
  // Pre-existing files consciously skipped (durable sessions dir mode).
  const ignored = new Set<string>();
  let draining = false;
  let drainQueued = false;
  let closed = false;
  let pollTimer: NodeJS.Timeout | null = null;

  const makeParser = (source: string): RolloutParser =>
    createRolloutParser({
      querySource: source,
      enqueue: (event) => {
        try {
          options.enqueue(event);
        } catch (err) {
          log('rollout-reader: enqueue threw', { error: errMsg(err) });
        }
      },
      log,
    });

  /** Begin tailing one rollout file from `offset`. */
  const startTracking = (
    full: string,
    source: string,
    offset: number,
    attachWatcher: boolean,
  ): void => {
    const tf: TrackedFile = { offset, parser: makeParser(source), source, watcher: null };
    tracked.set(full, tf);
    log('rollout-reader: tailing rollout', { path: full, source, offset });
    if (!attachWatcher) return;
    try {
      tf.watcher = watch(full, () => {
        void drainAll();
      });
      tf.watcher.on('error', (err) => {
        log('rollout-reader: watcher error, relying on poll', { error: errMsg(err) });
        try {
          tf.watcher?.close();
        } catch {
          /* ignore */
        }
        tf.watcher = null;
      });
    } catch (err) {
      log('rollout-reader: watch failed, relying on poll', { error: errMsg(err) });
      tf.watcher = null;
    }
  };

  /**
   * Scan the sessions dir for rollout files and start tracking any not
   * seen yet. New subagent files appear mid-session, so this runs on
   * every poll (and once more at close). `attachWatchers=false` at close
   * time keeps the final pass from wiring up watchers we're about to drop.
   */
  const discover = (attachWatchers = true): void => {
    let entries: string[];
    try {
      entries = readdirSync(options.sessionsDir, { recursive: true }) as string[];
    } catch {
      // sessions dir not created yet — codex makes it lazily.
      return;
    }
    const rootId = options.getSessionId?.() ?? null;
    for (const rel of entries) {
      const name = basename(rel);
      if (!ROLLOUT_RE.test(name)) continue;
      const full = join(options.sessionsDir, rel);
      if (tracked.has(full) || ignored.has(full)) continue;
      startTracking(full, sourceFor(name, rootId), 0, attachWatchers);
    }
  };

  /**
   * Durable-sessions mode: snapshot the files already on disk. They are
   * prior runs' history — captured when written, so re-parsing them
   * would duplicate every event in the feed. The one exception is the
   * thread being resumed: its file is tailed from its CURRENT size so
   * exactly the turns this run appends get captured. Runs before the
   * poll/watchers start, and before the adapter's resume handshake, so
   * nothing can have been appended yet.
   */
  if (options.preexisting === 'ignore') {
    let entries: string[] = [];
    try {
      entries = readdirSync(options.sessionsDir, { recursive: true }) as string[];
    } catch {
      // sessions dir not created yet — nothing pre-exists.
    }
    for (const rel of entries) {
      const name = basename(rel);
      if (!ROLLOUT_RE.test(name)) continue;
      const full = join(options.sessionsDir, rel);
      if (options.resumeThreadId && name.includes(options.resumeThreadId)) {
        let size = 0;
        try {
          size = statSync(full).size;
        } catch {
          // vanished between readdir and stat — tail from 0 if it returns.
        }
        startTracking(full, 'codex_main_thread', size, true);
      } else {
        ignored.add(full);
      }
    }
  }

  /** Read every complete new line for one file since its offset. Never throws. */
  const drainFile = async (path: string, tf: TrackedFile): Promise<void> => {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(path, 'r');
    } catch {
      return; // vanished transiently; poll retries
    }
    try {
      const stat = await handle.stat();
      if (stat.size <= tf.offset) return;
      const len = stat.size - tf.offset;
      const buf = Buffer.alloc(len);
      const { bytesRead } = await handle.read(buf, 0, len, tf.offset);
      if (bytesRead <= 0) return;
      // Consume only up to the LAST newline — a partial trailing line is
      // still being written. Byte-wise (0x0A never appears mid-UTF-8).
      const lastNl = buf.lastIndexOf(NEWLINE, bytesRead - 1);
      if (lastNl < 0) return;
      const completeText = buf.subarray(0, lastNl).toString('utf8');
      tf.offset += lastNl + 1;
      for (const line of completeText.split('\n')) {
        if (line.trim().length === 0) continue;
        tf.parser.handleLine(line);
      }
    } finally {
      await handle.close();
    }
  };

  /**
   * Drain every tracked file. Serialized against itself so poll +
   * fs.watch overlap is safe. Never throws.
   */
  const drainAll = async (): Promise<void> => {
    if (draining) {
      drainQueued = true;
      return;
    }
    draining = true;
    try {
      for (const [path, tf] of tracked) {
        try {
          await drainFile(path, tf);
        } catch (err) {
          log('rollout-reader: drain error', { path, error: errMsg(err) });
        }
      }
    } finally {
      draining = false;
      if (drainQueued && !closed) {
        drainQueued = false;
        void drainAll();
      }
    }
  };

  pollTimer = setInterval(() => {
    discover();
    void drainAll();
  }, pollMs);
  if (typeof pollTimer.unref === 'function') pollTimer.unref();

  discover();
  void drainAll();

  return {
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      for (const tf of tracked.values()) {
        if (tf.watcher) {
          try {
            tf.watcher.close();
          } catch {
            /* ignore */
          }
          tf.watcher = null;
        }
      }
      // One last discover (in case codex only just wrote a file) + drain,
      // so the tail written since the last poll lands before the parser
      // flush and before the adapter deletes CODEX_HOME.
      discover(false);
      await drainAllFinal();
      for (const tf of tracked.values()) tf.parser.flush();
    },
  };

  // Close-time drain: waits out any in-flight drain, then does one
  // guaranteed pass over every tracked file.
  async function drainAllFinal(): Promise<void> {
    while (draining) await new Promise((r) => setTimeout(r, 5));
    draining = true;
    try {
      for (const [path, tf] of tracked) {
        try {
          await drainFile(path, tf);
        } catch (err) {
          log('rollout-reader: final drain error', { path, error: errMsg(err) });
        }
      }
    } finally {
      draining = false;
    }
  }
}
