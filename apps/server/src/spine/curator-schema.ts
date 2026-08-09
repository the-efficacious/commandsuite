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

import type { SpineEventKind } from 'csuite-sdk/types';

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
    -- WHETHER THAT NUDGE LANDED, and it is the difference between the
    -- two things "spent" can mean.
    --
    -- A DELIVERED nudge is spent for its epoch, full stop: the member
    -- was told, and only a genuine new epoch (a lease re-grant) resets
    -- it. An UNDELIVERED one was spent on nobody — the sink took
    -- nothing — and that is the entire case the epoch re-arm exists
    -- for: the offline member whose push failed and who later comes
    -- back. Without this column the re-arm cannot tell them apart, so
    -- every proof of liveness re-opened every nudge, and a member
    -- writing steadily was nudged on every sweep tick. That is the
    -- dead objective-context watchdog rebuilt with better tables.
    nudge_delivered INTEGER CHECK(nudge_delivered IN (0,1)),
    PRIMARY KEY (member, ref)
  );
  CREATE INDEX IF NOT EXISTS spine_leases_member_idx ON spine_leases (member, granted_at);

  -- ─── Nudge cadence ──────────────────────────────────────────────
  --
  -- WHEN A NUDGE WAS LAST ATTEMPTED, per member, and deliberately NOT
  -- a column the re-arm can reach.
  --
  -- This lived as MAX(nudged_at) over the member's leases, which reads
  -- like a saving until you notice that the re-arm nulls exactly those
  -- values: after any proof of liveness the aggregate floor had no
  -- rows to compute itself from and waved everything through. Measured
  -- at the time: ten discussion posts over five minutes produced
  -- eleven nudges against a fifteen-minute floor.
  --
  -- A floor whose input another operation can erase is not a floor. It
  -- gets its own table so that no future clearing of lease state can
  -- silently disarm it — the failure mode is not that someone forgets
  -- the rule, it is that the rule shares storage with something whose
  -- job is to forget.
  CREATE TABLE IF NOT EXISTS spine_nudge_cadence (
    member TEXT PRIMARY KEY,
    -- The ATTEMPT, not the delivery. A nudge into a dead sink still
    -- costs the sweep and still counts against the cadence; what it
    -- does not cost is the member's epoch.
    last_attempt_at INTEGER NOT NULL
  );

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
    -- orient | annex_read | ack. NOT event_read: a by-id read proves
    -- one event was seen and nothing about the events below it, so it
    -- establishes no watermark and moves nothing.
    via TEXT NOT NULL
  );

  -- ─── Injections ─────────────────────────────────────────────────
  --
  -- The ledger. "What did the system spend of my album this week" is
  -- one query over this table, which is the only reason that question
  -- is answerable at all.
  --
  -- NO BODY COLUMN, and the reason is NOT confidentiality. Every
  -- injection is a broker push, so its text is already durable in the
  -- broker's event log and readable at GET /history — a copy here
  -- would leak nothing that is not already retrievable.
  --
  -- The reason is that this is an ACCOUNT, not an archive. It answers
  -- two questions — how much of this member's album was spent, and
  -- about what — and both are answered by bytes and refs. A second
  -- copy of the text would be a copy that can drift from the log it
  -- duplicates, that has to be retained and redacted on its own
  -- schedule, and that grows the ledger by the size of the traffic it
  -- is supposed to summarise.
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
  --
  -- THE INTERRUPT WHITELIST rides here too, as a JSON array of event
  -- kinds — which class-1 deliveries may reach a phone (§9). It lives on
  -- the policy row and not in its own table because it is one more piece
  -- of the same per-member attention policy, tuned the same way and
  -- carrying the same updated-by/at trail. NULL is "run the team
  -- default"; a stored array (including the empty one, "never buzz me")
  -- is an authored choice, exactly as an absent vs present row is
  -- everywhere else in this schema.
  CREATE TABLE IF NOT EXISTS spine_curator_policy (
    member TEXT PRIMARY KEY,
    lease_ttl_ms INTEGER NOT NULL,
    nudge_min_interval_ms INTEGER NOT NULL,
    interrupt_whitelist TEXT,
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

/**
 * The team-default interrupt whitelist — the class-1 kinds that buzz a
 * phone when a member has authored no whitelist of their own.
 *
 * §9's plausible director default, made the team default because it is
 * harmless for the members who have no phone (an agent's runner is a
 * browser it does not carry). Two kinds only, and each is a decision a
 * human should not miss while away from their screen:
 *
 *   ask         a blocking ask naming them as the authority — someone is
 *               stopped, waiting on a choice that is theirs to make;
 *   proceeding  someone proceeded PAST their ask without waiting for the
 *               ruling. The citation lock made that a legitimate, typed
 *               act rather than a silent one, and being released from a
 *               decision somebody asked you to make is not the absence
 *               of news — it is news the authority should get.
 *
 * Everything else stays quiet in the queue until they look. The
 * focus-set-running-dry trigger §9 also names is phase 6 — the focus set
 * does not exist yet, so it is not here.
 */
export const DEFAULT_INTERRUPT_WHITELIST: SpineEventKind[] = ['ask', 'proceeding'];

/** The curator tables, for the test that proves the curator can be dropped whole. */
export const SPINE_CURATOR_TABLES: readonly string[] = [
  'spine_leases',
  'spine_nudge_cadence',
  'spine_receipts',
  'spine_injections',
  'spine_subscriptions',
  'spine_curator_policy',
];
