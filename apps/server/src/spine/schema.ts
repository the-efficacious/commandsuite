/**
 * The annex's tables, in one place.
 *
 * TWO CLASSES OF TABLE and the difference is load-bearing.
 *
 *   TRUTH        `spine_events`, `spine_subjects`, `spine_revisions`.
 *                Append-only. Nothing in this module updates or
 *                deletes a row in any of them, and there is no code
 *                path that can.
 *
 *   PROJECTIONS  `spine_event_index`, `spine_contracts`,
 *                `spine_contract_verdicts`, `spine_contract_waivers`,
 *                `spine_asks`. Folds over the event stream, dropped
 *                and rebuilt from scratch by `rebuildProjections()`.
 *                Nothing may be true here that is not derivable from
 *                the events, and the rebuild test is what holds that.
 *
 * `spine_ops` is neither: it is the idempotency ledger, and it records
 * the canonical payload a caller sent at first write so a retry can be
 * told apart from a different write wearing the same id. It survives a
 * rebuild because the input it remembers is not fully recoverable from
 * the event it produced.
 *
 * WHY `contract` AND `state_rev` ARE NOT COLUMNS ON `spine_events`.
 * The event table is the §3 shape and nothing else — captions and a
 * body. Which contract an event touched, and what the counter read
 * afterwards, are both FOLDS: a correction reaches a contract only
 * through the event it staples to, and the counter is a running total.
 * Putting either in the truth table would make the annex hold derived
 * state, and then a rebuild could disagree with it and nothing would
 * say which was right.
 */

export const SPINE_SCHEMA = `
  -- ─── Truth ──────────────────────────────────────────────────────

  CREATE TABLE IF NOT EXISTS spine_events (
    -- INTEGER PRIMARY KEY, so SQLite assigns max+1 on every insert.
    -- Nothing ever deletes, so the stream is gapless and a reader that
    -- has seen seq N has seen everything up to N. That property is the
    -- entire recovery story; it is worth the rowid alias.
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    class TEXT NOT NULL CHECK(class IN ('authoritative','ambient')),
    -- Nullable: a discussion post is about a contract, not a region of
    -- the world, and forcing a subject on it would invent one.
    subject_id TEXT,
    revision_id TEXT,
    actor TEXT NOT NULL,
    -- For probe results: whose recipe fired. The member took the
    -- photo; the system only held the camera.
    authored_by TEXT,
    at TEXT NOT NULL,
    provenance TEXT NOT NULL CHECK(provenance IN ('native','legacy_projection')),
    -- UNIQUE and nullable: required on authoritative writes, absent on
    -- ambient ones. The uniqueness is the second line of defence
    -- behind the ledger — two events can never share an op_id even if
    -- the ledger check were bypassed.
    op_id TEXT UNIQUE,
    cites TEXT NOT NULL DEFAULT '[]',
    staples_to TEXT,
    body TEXT NOT NULL,
    FOREIGN KEY (subject_id) REFERENCES spine_subjects(id),
    FOREIGN KEY (revision_id) REFERENCES spine_revisions(id)
  );
  CREATE INDEX IF NOT EXISTS spine_events_kind_idx ON spine_events (kind, seq);
  CREATE INDEX IF NOT EXISTS spine_events_subject_idx ON spine_events (subject_id, seq);
  CREATE INDEX IF NOT EXISTS spine_events_actor_idx ON spine_events (actor, seq);
  CREATE INDEX IF NOT EXISTS spine_events_staples_idx ON spine_events (staples_to);

  CREATE TABLE IF NOT EXISTS spine_subjects (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN ('repo','pr','file','issue','setting','package','doc')),
    -- Declared at registration and never moved. There is no update
    -- path, which is also why the graph cannot cycle: a parent must
    -- already exist when its child is registered.
    parent TEXT,
    registered_by TEXT NOT NULL,
    at TEXT NOT NULL,
    FOREIGN KEY (parent) REFERENCES spine_subjects(id)
  );
  CREATE INDEX IF NOT EXISTS spine_subjects_parent_idx ON spine_subjects (parent);

  -- EVERY COLUMN NOT NULL, deliberately. A revision row with a null
  -- source is "verified at abc123" with nobody saying who looked, and
  -- that is the exact shape §4 exists to make unrepresentable. The
  -- constraint is here as well as in the schema because a store is
  -- reachable by a migration that is not.
  CREATE TABLE IF NOT EXISTS spine_revisions (
    id TEXT PRIMARY KEY,
    subject_id TEXT NOT NULL,
    value TEXT NOT NULL,
    how TEXT NOT NULL CHECK(how IN ('observed','asserted')),
    source TEXT NOT NULL,
    at TEXT NOT NULL,
    FOREIGN KEY (subject_id) REFERENCES spine_subjects(id)
  );
  CREATE INDEX IF NOT EXISTS spine_revisions_subject_idx ON spine_revisions (subject_id, at);

  -- ─── Idempotency ledger ─────────────────────────────────────────

  CREATE TABLE IF NOT EXISTS spine_ops (
    op_id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    -- Canonical JSON of the semantic payload, so "same id, same
    -- payload" is decided by comparing bytes rather than by walking
    -- two objects and hoping the walk is complete.
    payload TEXT NOT NULL,
    at TEXT NOT NULL
  );

  -- ─── Projections ────────────────────────────────────────────────

  -- One row per event: which contract it touched (if any) and what
  -- that contract's counter read afterwards. Both are folds, so both
  -- live here rather than on the event.
  CREATE TABLE IF NOT EXISTS spine_event_index (
    seq INTEGER PRIMARY KEY,
    contract_id TEXT,
    state_rev INTEGER
  );
  CREATE INDEX IF NOT EXISTS spine_event_index_contract_idx
    ON spine_event_index (contract_id, seq);

  CREATE TABLE IF NOT EXISTS spine_contracts (
    -- The specification event's id. A contract IS its founding photo;
    -- minting a second identifier would create two names for one thing
    -- and a join to keep them agreeing.
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    state TEXT NOT NULL,
    state_rev INTEGER NOT NULL,
    version INTEGER NOT NULL,
    subject_id TEXT NOT NULL,
    revision_id TEXT,
    criteria TEXT NOT NULL,
    assignee TEXT NOT NULL,
    verifier TEXT,
    authority TEXT,
    constraints TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    waiting_on TEXT,
    waiting_for TEXT,
    preempted_by TEXT,
    result TEXT,
    reason TEXT,
    successor TEXT,
    spec_seq INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS spine_contracts_assignee_idx ON spine_contracts (assignee);
  CREATE INDEX IF NOT EXISTS spine_contracts_verifier_idx ON spine_contracts (verifier);
  CREATE INDEX IF NOT EXISTS spine_contracts_authority_idx ON spine_contracts (authority);
  CREATE INDEX IF NOT EXISTS spine_contracts_subject_idx ON spine_contracts (subject_id);

  -- Latest verdict per criterion PER REVISION. Keyed that way because
  -- a verdict is only ever true of the revision it was reached at, so
  -- a later verdict at a new revision must not overwrite the record of
  -- what was true at the old one — that record is what keeps a
  -- superseded contract terminal at its own revision, verdicts intact.
  CREATE TABLE IF NOT EXISTS spine_contract_verdicts (
    contract_id TEXT NOT NULL,
    criterion_id TEXT NOT NULL,
    revision_id TEXT NOT NULL,
    decision TEXT NOT NULL,
    event_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    seq INTEGER NOT NULL,
    at TEXT NOT NULL,
    PRIMARY KEY (contract_id, criterion_id, revision_id)
  );

  -- A ruling that waives a cannot_verify. The third of the three legal
  -- moves after a verifier says they cannot tell.
  CREATE TABLE IF NOT EXISTS spine_contract_waivers (
    contract_id TEXT NOT NULL,
    criterion_id TEXT NOT NULL,
    revision_id TEXT NOT NULL,
    ruling_event_id TEXT NOT NULL,
    PRIMARY KEY (contract_id, criterion_id, revision_id)
  );

  CREATE TABLE IF NOT EXISTS spine_asks (
    id TEXT PRIMARY KEY,
    authority TEXT NOT NULL,
    asker TEXT NOT NULL,
    subject_id TEXT,
    contract_id TEXT,
    question TEXT NOT NULL,
    context TEXT NOT NULL,
    unblocks TEXT NOT NULL,
    state TEXT NOT NULL,
    resolved_by TEXT,
    at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS spine_asks_authority_idx ON spine_asks (authority, state);
  CREATE INDEX IF NOT EXISTS spine_asks_asker_idx ON spine_asks (asker, state);

  -- The focus set (D9): one row per contract that has ever had a focus
  -- event, holding its CURRENT membership. lit = 1 means the contract
  -- is in the team's focus set — lit for travel now — and lit = 0 is
  -- an authored unlight, kept (rather than deleted) so the last member
  -- to touch focus and their reason survive. A contract with no row here
  -- has never been touched by focus and is not in the set.
  --
  -- A PROJECTION, folded from focus events and nothing else, so it is
  -- dropped and rebuilt with every other projection. Membership is a
  -- SET: every focus event flips lit, and the store refuses a focus
  -- event that would not change it, so this row and the event stream can
  -- never disagree about what is lit.
  CREATE TABLE IF NOT EXISTS spine_focus (
    contract_id TEXT PRIMARY KEY,
    lit INTEGER NOT NULL CHECK(lit IN (0,1)),
    reason TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    event_id TEXT NOT NULL
  );
`;

/**
 * The projection tables, in dependency-free order. `rebuildProjections`
 * clears exactly these and nothing else, and the list lives here next
 * to the DDL so a new projection cannot be added without landing in
 * the rebuild.
 */
export const SPINE_PROJECTION_TABLES: readonly string[] = [
  'spine_event_index',
  'spine_contracts',
  'spine_contract_verdicts',
  'spine_contract_waivers',
  'spine_asks',
  'spine_focus',
];
