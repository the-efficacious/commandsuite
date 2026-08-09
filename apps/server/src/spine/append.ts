/**
 * THE ONE WRITE PATH INTO THE ANNEX, and the module that makes "one"
 * a fact about the type system rather than a fact about a grep.
 *
 * WHY THIS FILE EXISTS. The curator's class-1 injection hangs off a
 * post-commit hook on the append path: an `ask` naming you has to reach
 * your sink, and the only place that knows an ask landed is the code
 * that landed it. A second append path anywhere in the server would be
 * a write whose addressees are never told — and it would be INVISIBLE,
 * because the annex would be perfectly correct, the event would be
 * there, and the member who needed to know would simply never hear.
 * Silence has no error message.
 *
 * Phase 3 held that with a regex over `src/`, matching `.append(` on a
 * list of plausible receiver names (`spine|annex|store|…`). That was
 * honest about being a heuristic and it was flagged as the condition of
 * phase 4, for the obvious reason: the failure it exists to catch is a
 * NEW MODULE holding the store under a NEW NAME, which is precisely the
 * case a receiver-name allowlist cannot see. The probe engine is that
 * new module, so the heuristic had to go before it arrived.
 *
 * WHAT REPLACES IT — two nets, and the first is the compiler's.
 *
 *   THE TYPE SPLIT. `AnnexStore` — the type every consumer receives —
 *   HAS NO `append`. The method lives on `AnnexWriter`, which the
 *   factory returns and which exactly one module in `src/` is allowed
 *   to name. Everything downstream (the route layer, the curator, the
 *   probe engine) holds a read-only handle, so `spine.append(…)` in a
 *   new module is not a missed grep, it is a type error at the call
 *   site. A rename cannot dodge a method that is not on the type.
 *
 *   THE IMPORT ASSERTION. A handle can also arrive as a parameter, so
 *   the compiler alone is not enough: someone has to be able to obtain
 *   a writer in the first place. Obtaining one means naming
 *   `AnnexWriter` or `createSqliteAnnexStore` in an import statement,
 *   and an import specifier is fixed text in the importing file — an
 *   alias (`import { AnnexWriter as W }`) still contains the exported
 *   name. So `spine-append-callers.test.ts` asserts the set of `src/`
 *   modules that import either name, and that set is this one file.
 *   That is a property of the import graph, which is what "structural"
 *   has to mean here.
 *
 * HOOKS, NOT A HARD-WIRED CURATOR. Two subsystems now need to see every
 * committed write — the curator (who to tell) and the probe engine
 * (which checks to arm and disarm) — and the probe engine writes back
 * through this path, so wiring either one in as a constructor argument
 * would make the construction order circular. A hook list breaks the
 * cycle and keeps the rule the same: everything that must see a write
 * registers here, and there is nowhere else to register.
 *
 * A HOOK'S FAILURE NEVER FAILS THE WRITE. The event is already in the
 * annex when the hooks run; refusing the response now would tell the
 * caller their write did not land, which is the one thing that is not
 * true. Hook failures are logged and swallowed, individually, so one
 * broken hook cannot silence the others.
 */

import type { AppendSpineEventRequest } from 'csuite-sdk/types';
import type { DatabaseSyncInstance } from '../db.js';
import type { Logger } from '../logger.js';
import {
  type AnnexStore,
  type AnnexWriter,
  type AppendContext,
  type AppendResult,
  createSqliteAnnexStore,
} from './store.js';

/** Post-commit observer of a committed append. Never able to fail the write. */
export type AppendHook = (result: AppendResult) => Promise<void>;

export interface AnnexWritePath {
  /**
   * The annex's READ surface, and the only handle this server hands
   * out. It has no `append`, which is the whole point.
   */
  readonly store: AnnexStore;
  /**
   * Append one event, then run every registered hook.
   *
   * The annex write itself is SYNCHRONOUS and happens before the first
   * `await` below, so two callers interleaving at their own awaits can
   * never both see the pre-write state. The probe engine's one-fire
   * claim depends on that ordering.
   */
  append(input: AppendSpineEventRequest, ctx: AppendContext): Promise<AppendResult>;
  /** Register a post-commit observer. Registration order is delivery order. */
  onAppend(hook: AppendHook): void;
}

export interface AnnexWritePathOptions {
  db: DatabaseSyncInstance;
  logger: Logger;
}

class SpineWritePath implements AnnexWritePath {
  readonly store: AnnexStore;
  private readonly writer: AnnexWriter;
  private readonly logger: Logger;
  private readonly hooks: AppendHook[] = [];

  constructor(options: AnnexWritePathOptions) {
    // Constructed HERE rather than handed in, so no caller ever holds
    // an append-capable handle. The composition root asks for a write
    // path and gets one; there is no arrangement of the wiring that
    // leaves a bare writer lying around for a new module to be passed.
    const writer = createSqliteAnnexStore(options.db);
    this.writer = writer;
    this.store = writer;
    this.logger = options.logger;
  }

  onAppend(hook: AppendHook): void {
    this.hooks.push(hook);
  }

  async append(input: AppendSpineEventRequest, ctx: AppendContext): Promise<AppendResult> {
    // Synchronous, and deliberately not awaited into. Everything from
    // the idempotency check to the projection fold happens in this one
    // call, so the event is committed before any hook or any concurrent
    // caller gets the event loop back.
    const result = this.writer.append(input, ctx);
    for (const hook of this.hooks) {
      try {
        await hook(result);
      } catch (err) {
        this.logger.warn('spine append hook failed', {
          event: result.event.id,
          kind: result.event.kind,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return result;
  }
}

export function createAnnexWritePath(options: AnnexWritePathOptions): AnnexWritePath {
  return new SpineWritePath(options);
}
