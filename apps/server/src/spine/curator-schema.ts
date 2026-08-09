/**
 * The curator's tables — operational bookkeeping, NOT annex events.
 *
 * WHY THESE ARE NOT PHOTOGRAPHS. Axiom 6 says albums are private, to
 * the system too, and the annex records what MEMBERS did. Leases,
 * receipts, injections and subscription levels are none of those: they
 * are what the SYSTEM did with a member's attention. Writing them as
 * annex events would put the curator's own scheduling decisions into
 * the team's record of the world — a `criterion_verdict` and "we sent
 * Rune a one-line nudge at 14:02" would sit in the same stream, cite
 * each other, and advance the same cursor. The curator's ledger is
 * system state: auditable, exportable, never truth about the room.
 *
 * The practical consequence is the one that matters: these tables can
 * be dropped and rebuilt from nothing without losing a single fact
 * about the team. A lost lease costs one redundant re-orientation. A
 * lost annex event is history falsified. Different tables, because
 * different consequences.
 *
 * MILLISECONDS, NOT ISO, in every timestamp column here — the opposite
 * of the annex's choice, and deliberately. Annex captions are read by
 * members and must render whole; these columns are only ever compared
 * to a clock (`granted_at + ttl <= now`), and a store that does date
 * arithmetic on strings gets it wrong on the day someone changes the
 * format. The wire surface renders ISO at the boundary.
 */

export const SPINE_CURATOR_SCHEMA = `
  -- ─── Leases ─────────────────────────────────────────────────────
  --
  -- "Member M holds set S as of seq N." Confirmed at the DELIVERY SINK
  -- and never verified against context contents — the whole point of
  -- Gray & Cheriton's lease is that you do not ask the cache what it
  -- has; you time-bound your assumption and let the next act reveal
  -- the truth.
  --
  -- One row per (member, ref) rather than one per delivery: a lease is
  -- a standing claim about one thing, so a second delivery of the same
  -- ref RENEWS rather than accumulates. Rows accumulating per delivery
  -- would make "is this member's view of contract C current" a scan
  -- whose cost grows with how noisy the contract has been, which is
  -- backwards.
  CREATE TABLE IF NOT EXISTS spine_leases (
    member TEXT NOT NULL,
    -- A contract id, or an event id for a class-1 delivery that named
    -- no contract. Both are annex ids, so the column needs no tag.
    ref TEXT NOT NULL,
    -- The annex head when the lease was granted. "Since seq N" is what
    -- every delta is framed against, so it is stored, not recomputed.
    seq INTEGER NOT NULL,
    granted_at INTEGER NOT NULL,
    -- orient | class0 | class1 | class2 | act. 'act' is the write path
    -- renewing a lease the member's own append proved they hold.
    source TEXT NOT NULL,
    -- Set by a floor signal. NULL while the lease stands on its own
    -- clock. An invalidated lease is expired NOW rather than at
    -- granted_at + ttl — that difference is the entire value of a
    -- declared dump signal, and it is latency, never correctness.
    invalidated_at INTEGER,
    invalidated_by TEXT,
    -- When this generation's single nudge was spent. Cleared on every
    -- grant/renew, because a renewed lease is a new generation.
    nudged_at INTEGER,
    PRIMARY KEY (member, ref)
  );
  CREATE INDEX IF NOT EXISTS spine_leases_member_idx ON spine_leases (member, granted_at);

  -- ─── Receipts ───────────────────────────────────────────────────
  --
  -- How far a member has demonstrably READ. One row per member, and it
  -- only ever moves forward.
  --
  -- The curator's own pushes must never touch this table. Visiting is
  -- not handling; being told is not reading. A receipt advanced by a
  -- push would let the system mark its own homework, and every "you
  -- are caught up" it then rendered would be a claim about what it
  -- SENT rather than about what anybody took in.
  CREATE TABLE IF NOT EXISTS spine_receipts (
    member TEXT PRIMARY KEY,
    seq INTEGER NOT NULL,
    at INTEGER NOT NULL,
    -- orient | annex_read | event_read | ack
    via TEXT NOT NULL
  );

  -- ─── Injections ─────────────────────────────────────────────────
  --
  -- The ledger. "What did the system spend of my album this week" is
  -- one query over this table, which is the only reason that question
  -- is answerable at all.
  --
  -- NO BODY COLUMN, on purpose. The ledger accounts for spend; keeping
  -- the text would make the audit trail a second copy of the member's
  -- traffic and therefore a second place it can leak from. Bytes and
  -- refs are enough to answer both questions anyone asks of it — how
  -- much, and about what.
  CREATE TABLE IF NOT EXISTS spine_injections (
    id INTEGER PRIMARY KEY,
    member TEXT NOT NULL,
    -- 0 recovery · 1 addressed · 2 subscription delta. There is no 3:
    -- class 3 is silence, and a row recording silence would be a
    -- contradiction — and a budget line for something never spent.
    class INTEGER NOT NULL CHECK(class IN (0,1,2)),
    kind TEXT NOT NULL,
    refs TEXT NOT NULL,
    cursor INTEGER NOT NULL,
    at INTEGER NOT NULL,
    bytes INTEGER NOT NULL,
    delivered INTEGER NOT NULL CHECK(delivered IN (0,1))
  );
  CREATE INDEX IF NOT EXISTS spine_injections_member_idx ON spine_injections (member, id);

  -- ─── Subscriptions (policy as DATA) ─────────────────────────────
  --
  -- Reader-side level per member per contract — #155 finding 1's
  -- answer. A row is an AUTHORED choice; its absence is the derived
  -- default, and the two are kept distinguishable on the wire because
  -- "nobody has had an opinion about this" and "somebody chose this"
  -- are different facts that would otherwise render identically.
  CREATE TABLE IF NOT EXISTS spine_subscriptions (
    member TEXT NOT NULL,
    contract_id TEXT NOT NULL,
    level TEXT NOT NULL CHECK(level IN ('all','lifecycle','none')),
    updated_by TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (member, contract_id)
  );

  -- ─── Cadence (policy as DATA, continued) ────────────────────────
  --
  -- Per-member, with the same updated-by/at trail, for the same
  -- reason: attention allocation is the contested resource, and tuning
  -- it must never mean shipping a release. A member with no row runs
  -- on the team defaults, which is a state and not a gap.
  CREATE TABLE IF NOT EXISTS spine_curator_policy (
    member TEXT PRIMARY KEY,
    lease_ttl_ms INTEGER NOT NULL,
    nudge_min_interval_ms INTEGER NOT NULL,
    updated_by TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`;

/**
 * Team defaults, applied to any member with no authored policy row.
 *
 * A LEASE TTL is not a guess about how long context survives — nobody
 * can know that, which is why leases exist instead of detection. It is
 * how long the curator is willing to ASSUME a member still holds what
 * it handed them before offering one cheap pointer back to `orient`.
 * Thirty minutes is long enough that an active member's own writes
 * keep renewing it (the write path is the floor, and it is free), and
 * short enough that an idle member with unread acts gets pointed at
 * recovery within one working stretch.
 */
export const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000;

/**
 * Floor on the gap between two nudges to the same member, across ALL
 * their leases. The per-lease rule already caps a nudge at one per
 * generation; this caps the aggregate, so a member holding twelve
 * leases that expire together gets one line and not twelve.
 */
export const DEFAULT_NUDGE_MIN_INTERVAL_MS = 15 * 60 * 1000;

/** The curator tables, for the test that proves the curator can be dropped whole. */
export const SPINE_CURATOR_TABLES: readonly string[] = [
  'spine_leases',
  'spine_receipts',
  'spine_injections',
  'spine_subscriptions',
  'spine_curator_policy',
];
