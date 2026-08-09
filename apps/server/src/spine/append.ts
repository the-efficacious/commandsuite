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

import type { AppendSpineEventRequest, SpineRevisionInput } from 'csuite-sdk/types';
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

/**
 * WHAT A PROBE MAY HAND THE ANNEX — the closed list, as a type.
 *
 * §7 gives the probe engine exactly two writes: the `observation` a
 * firing recipe produces, and the `lifecycle` back to `active` that
 * re-lights a `waiting_for` contract citing it. Everything else in the
 * kind registry is a JUDGEMENT — a verdict, a ruling, a specification —
 * and §10 forbids the system to make one by name.
 *
 * The store refuses the rest at runtime, and must, because a store is
 * reachable by callers no compiler saw. This type is the other half:
 * inside the engine, a discussion or a verdict is not a refusal to
 * handle, it is a call that does not typecheck.
 * `spine-boundary.test-d.ts` puts the hostile shapes in front of `tsc`
 * so the claim cannot rot into a comment.
 */
/**
 * A revision a probe may caption an event with: OBSERVED, never
 * asserted.
 *
 * D2 and §10 in one field. `observed` means a flash went off;
 * `asserted` means somebody named a value by hand, which is authored
 * intent — epistemically a different object, and the system has no
 * intent to author. An asserted revision from a probe would also be a
 * derived value with a caption that lies about how it was obtained,
 * which is precisely the shape §4 exists to make unrepresentable.
 *
 * Only `observed` revisions move a subject's head, so the practical
 * consequence is smaller than the epistemic one — but it is exactly the
 * direction that matters: the system must never be able to declare that
 * the world is at a revision nobody looked at.
 */
type ObservedRevisionInput = Omit<SpineRevisionInput, 'how'> & { how: 'observed' };

export type ProbeAppendRequest =
  | (Omit<Extract<AppendSpineEventRequest, { kind: 'observation' }>, 'revision'> & {
      revision?: ObservedRevisionInput;
    })
  | (Omit<Extract<AppendSpineEventRequest, { kind: 'lifecycle' }>, 'revision'> & {
      revision?: ObservedRevisionInput;
    });

/** Who fired, and on whose behalf. Both captions, or the store refuses the write. */
export interface ProbeIdentity {
  /** The check id. Becomes `actor: probe:<id>`. */
  check: string;
  /** The member whose recipe fired. Becomes `authored_by`. */
  authoredBy: string;
  now: number;
}

/**
 * The read methods, as DATA, because the facade below is built from
 * this list rather than from a spread of the writer.
 *
 * A `{ ...writer }` facade would carry `append` along with everything
 * else and the whole exercise would be decorative. An explicit list
 * cannot do that: a method absent from it is absent from the object,
 * and adding a read method is a one-line edit that fails loudly (the
 * caller gets `undefined is not a function`) rather than silently
 * widening the surface.
 */
const READ_METHODS = [
  'event',
  'events',
  'registerSubject',
  'subject',
  'subjects',
  'revision',
  'contract',
  'contracts',
  'ask',
  'orient',
  'queue',
  'rebuildProjections',
] as const satisfies readonly (keyof AnnexStore)[];

export interface AnnexWritePath {
  /**
   * The annex's READ surface, and the only handle this server hands
   * out.
   *
   * A GENUINE FACADE, not the writer wearing a narrower type. The
   * first version of this returned the writer itself and relied on
   * `AnnexStore` having no `append` — which is a compile-time claim,
   * and a compile-time claim about an object is defeated by one cast:
   * `(path.store as unknown as { append: … }).append(…)` reached the
   * annex, imported nothing from `store.js` but types, and bypassed
   * every post-commit hook. The event landed, no check armed, no
   * curator line went out, and the scanner saw nothing because there
   * was nothing to see.
   *
   * So the object handed out genuinely does not have the method. The
   * cast now returns `undefined` and throws at the call site — which
   * is the difference between an architecture and an argument.
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
  /**
   * The probe engine's write, narrowed to the two kinds §7 allows and
   * with the provenance pair assembled HERE rather than at each call
   * site. A probe that forgot `authored_by` would be the system taking
   * a photograph on its own judgement, and forgetting is exactly what a
   * per-call-site convention invites.
   */
  appendAsProbe(input: ProbeAppendRequest, probe: ProbeIdentity): Promise<AppendResult>;
  /** Register a post-commit observer. Registration order is delivery order. */
  onAppend(hook: AppendHook): void;
}

export interface AnnexWritePathOptions {
  db: DatabaseSyncInstance;
  logger: Logger;
}

class SpineWritePath implements AnnexWritePath {
  readonly store: AnnexStore;
  /**
   * The append-capable handle, as a REAL private field.
   *
   * `private readonly writer` was a TYPE-only private: `private` is
   * erased at runtime, so `(path as unknown as { writer: AnnexWriter })
   * .writer.append(…)` reached the writer by a cast, bypassing every
   * post-commit hook — the same class of hole `readOnlyFacade` closes
   * for `store`, left open on the write path itself. `#writer` is a
   * genuine JS private: it is not a property on the object, no cast
   * reaches it, and `in` from outside the class throws rather than
   * probes. There is no readonly modifier because `#` fields cannot
   * carry one; it is assigned once here and never again.
   */
  #writer: AnnexWriter;
  private readonly logger: Logger;
  private readonly hooks: AppendHook[] = [];

  constructor(options: AnnexWritePathOptions) {
    // Constructed HERE rather than handed in, so no caller ever holds
    // an append-capable handle. The composition root asks for a write
    // path and gets one; there is no arrangement of the wiring that
    // leaves a bare writer lying around for a new module to be passed.
    const writer = createSqliteAnnexStore(options.db);
    this.#writer = writer;
    this.store = readOnlyFacade(writer);
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
    const result = this.#writer.append(input, ctx);
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

  async appendAsProbe(input: ProbeAppendRequest, probe: ProbeIdentity): Promise<AppendResult> {
    return this.append({ ...input, authoredBy: probe.authoredBy } as AppendSpineEventRequest, {
      actor: `probe:${probe.check}`,
      now: probe.now,
    });
  }
}

/**
 * A frozen object carrying the read methods and nothing else.
 *
 * Bound rather than delegated through a Proxy, for two reasons that
 * are both about the failure being visible. A Proxy `get` trap that
 * filtered by name would still be an object whose shape depends on a
 * predicate someone can widen, and it would answer `undefined` for
 * `append` while still holding a live reference to the writer in its
 * closure — reachable by anyone who could reach the handler. This
 * holds a reference too, but it holds it the way every closure does,
 * and there is no key on the object that reaches it.
 *
 * Frozen so the facade cannot be re-fitted with an `append` by a
 * caller who has one; that is not the attack this exists for, but a
 * read-only surface that can be assigned to is not read-only.
 */
function readOnlyFacade(writer: AnnexWriter): AnnexStore {
  const facade: Partial<Record<(typeof READ_METHODS)[number], unknown>> = {};
  for (const name of READ_METHODS) {
    facade[name] = (writer[name] as (...args: unknown[]) => unknown).bind(writer);
  }
  return Object.freeze(facade) as AnnexStore;
}

export function createAnnexWritePath(options: AnnexWritePathOptions): AnnexWritePath {
  return new SpineWritePath(options);
}
