/**
 * The check registry — one table, and a third class of table in the
 * spine.
 *
 * The annex has TRUTH (append-only, never rewritten) and PROJECTIONS
 * (folds, droppable, rebuilt by `rebuildProjections`). The curator has
 * BOOKKEEPING (what the system spent of whose attention; droppable
 * without falsifying a single fact about the team). `spine_checks` is a
 * projection, and it is worth saying why rather than assuming it:
 *
 * EVERY COLUMN BUT ONE IS DERIVABLE FROM THE EVENT STREAM. Which asks
 * and which `waiting_for` lifecycles declared a recipe, whose they
 * were, what they point at, whether the ask was later withdrawn,
 * whether the contract moved off `waiting_for`, and whether a probe
 * observation exists for the check — all of it is in `spine_events`,
 * which is why `rebuildChecks()` can throw this table away and refold
 * it. The exception is `last_evaluated_at`, which is a fact about the
 * ENGINE (a predicate was tested and said no) rather than about the
 * team, and it is lost on a rebuild the way a lease is lost on a
 * restart: at the cost of one redundant evaluation.
 *
 * THE ID IS ITS OWN, and not the carrier event's, for one reason that
 * matters downstream: it becomes an ACTOR. `probe:<check-id>` appears
 * on every observation the check produces, in the annex forever, and an
 * actor whose name was `probe:evt_…` would read as a member acting as
 * an event. The `chk_` prefix makes a bare id in a citation legible,
 * which is the same argument `evt_` and `rev_` are made on.
 *
 * ONE FIRE PER ARMING is a UNIQUE index, not a convention. Re-arming
 * takes a new carrier event, and `source_event_id UNIQUE` is what makes
 * the materialisation idempotent under a replayed append: the same ask
 * arriving twice cannot produce two cameras pointed at one thing.
 */

export const SPINE_CHECK_SCHEMA = `
  CREATE TABLE IF NOT EXISTS spine_checks (
    -- chk_<ulid>. Becomes the actor on every observation it fires.
    id TEXT PRIMARY KEY,
    -- The ask or lifecycle event that armed it. UNIQUE, so a replayed
    -- append materialises nothing new.
    source_event_id TEXT NOT NULL UNIQUE,
    carrier TEXT NOT NULL CHECK(carrier IN ('ask','waiting_for')),
    -- What the observation will be OF. Resolved at authoring, and the
    -- carrier is refused when it resolves to nothing: a flash is always
    -- of somewhere.
    subject_id TEXT NOT NULL,
    -- Exactly one of these is set, and which one decides the discharge
    -- shape: a contract goes back to active citing the observation; an
    -- ask closes with the observation stapled to it.
    contract_id TEXT,
    ask_id TEXT,
    recipe TEXT NOT NULL,
    -- The member who composed it. Rides onto the observation as
    -- authored_by, which is the whole provenance story: the member took
    -- the photo, the system held the camera.
    authored_by TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('armed','fired','disarmed')),
    -- Set when the shutter closes. NULL while a fire is in flight,
    -- which is the one window in which state and evidence disagree —
    -- and the fire path turns a failed append into 'disarmed' rather
    -- than back into 'armed', because a check whose evidence could not
    -- be recorded is broken, not waiting.
    fired_event_id TEXT,
    fired_at TEXT,
    -- BOOKKEEPING, and the only column a rebuild loses. A predicate
    -- that evaluated false fires nothing and records no observation —
    -- a photograph is taken when the shot the member composed comes
    -- out, not on every shutter test — but "has anything been arriving
    -- at all" still has to be answerable.
    last_evaluated_at TEXT,
    disarmed_reason TEXT,
    at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS spine_checks_state_idx ON spine_checks (state, id);
  CREATE INDEX IF NOT EXISTS spine_checks_contract_idx ON spine_checks (contract_id);
  CREATE INDEX IF NOT EXISTS spine_checks_ask_idx ON spine_checks (ask_id);
  CREATE INDEX IF NOT EXISTS spine_checks_subject_idx ON spine_checks (subject_id);
`;

/**
 * The registry's tables, for the test that proves the registry can be
 * dropped and refolded. Sibling of `SPINE_PROJECTION_TABLES` and
 * `SPINE_CURATOR_TABLES`; a new one cannot be added without landing in
 * the rebuild, because the rebuild clears exactly this list.
 */
export const SPINE_CHECK_TABLES: readonly string[] = ['spine_checks'];
