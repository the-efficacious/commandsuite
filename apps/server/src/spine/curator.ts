/**
 * The curator — what enters whose album, and when.
 *
 * The annex is where the system's correctness lives; this is where it
 * is FELT. "It re-orients me" versus "it spams me" is entirely policy,
 * and attention is the one resource an organisation argues about
 * forever. So the two halves are kept apart on purpose: the levels,
 * the cadences and the per-member choices are rows in
 * `curator-store.ts`, and what is written below is only the machinery
 * that reads them.
 *
 * THE PROPERTY THIS FILE EXISTS TO HOLD, above every other, and stated
 * precisely rather than slogan-wise:
 *
 *   NO CORRECTNESS PROPERTY DEPENDS ON A SIGNAL. A signal may spend at
 *   most one additional nudge. The owed end state is identical.
 *
 * The middle clause is a real divergence and it is accepted rather
 * than explained away. A member who is going to read on their own in
 * five minutes, and whose runner declares a dump at one minute, gets a
 * nudge they would otherwise never have got: the signal moved the
 * lease before the read moved the receipt. That costs one line, it is
 * bounded at one however many signals arrive, and it cannot cost a
 * missed obligation — nothing a signal touches is an input to what a
 * member is OWED, only to when the curator stops assuming they still
 * hold it.
 *
 * An earlier draft of this header said "the end states are identical,
 * only the timing moves". That was overstated in exactly the direction
 * that makes a design sound better than it is, and the ledger can tell
 * the difference. `spine-curator.test.ts` drives the entire
 * class/lease/receipt suite with ZERO signals reported — enforced
 * behaviourally, by asserting after every test that no lease was ever
 * invalidated, not by a name check a rename can defeat.
 * `spine-curator-signals.test.ts` replays the same scenarios with
 * signals, asserts the owed end state is identical, and names the
 * extra-nudge arm as an accepted divergence.
 *
 * FOUR CLASSES, and the third is the interesting one:
 *
 *   0  recovery       the Guaranteed Pack. Reaches an album because a
 *                     member (or their runner) CALLED `orient` — the
 *                     server never pushes a pack. Never yields.
 *   1  addressed      an act that named you. One line: kind, id,
 *                     title, cursor. Never the text. Never yields.
 *   2  subscription   reader-side level per member per contract,
 *                     batched per tick so a busy contract cannot spam
 *                     a subscriber. Yields to silence.
 *   3  silence        parked and waiting-for contracts generate
 *                     nothing. Not "less"; nothing.
 *
 * "Never yields" means exactly what it says: class 0 and class 1 do
 * not consult `spine_subscriptions` at all. A member who set every
 * contract to `none` still gets the ask that named them, because that
 * ask is a claim on them and not a broadcast they opted into.
 */

import type { Broker } from 'csuite-core';
import type {
  ListSpineInjectionsQuery,
  Message,
  SpineAskActionBody,
  SpineAskBody,
  SpineContract,
  SpineContractState,
  SpineCuratorConfigResponse,
  SpineEvent,
  SpineEventKind,
  SpineFloorSignal,
  SpineInjection,
  SpineLifecycleBody,
  SpineProceedingBody,
  SpineRulingBody,
  SpineRunnerCapabilities,
  SpineSubscription,
  SpineSubscriptionLevel,
} from 'csuite-sdk/types';
import { SPINE_EVENT_CLASSES } from 'csuite-sdk/types';
import type { Logger } from '../logger.js';
import type { CuratorStore, LeaseRecord, ReceiptVia } from './curator-store.js';
import type { AnnexStore, AppendResult } from './store.js';

/**
 * The states class 3 silences.
 *
 * `parked` is the team choosing to stop and `waiting_for` is the room
 * owing the next move — in both, a reminder tells a member something
 * they already decided. Terminal states are NOT in the list, and that
 * is deliberate: a contract reaching `done` is the single most useful
 * lifecycle line a subscriber ever gets, and the event that carries it
 * is evaluated against the state the contract was in when it ARRIVED,
 * which was not terminal.
 */
const SILENT_STATES: ReadonlySet<SpineContractState> = new Set(['parked', 'waiting_for']);

/**
 * The lifecycle transitions that ADDRESS the people carrying the work,
 * rather than merely being available to whoever subscribed.
 *
 * Four states, two recipients — the assignee and the named verifier —
 * and the reason is that these are the transitions that CHANGE WHAT
 * SOMEBODY OWES rather than report on it. `done`, `cancelled` and
 * `superseded` end an obligation; `parked` suspends one. In every case
 * the person holding it must stop, and finding out at their next
 * `orient` means work done against a contract that no longer wanted
 * it.
 *
 * This is what makes `none` genuinely safe for an assignee rather than
 * nearly safe. Without it, the argument for defaulting assignees to
 * silence — everything that binds you arrives as class 1 — had a hole
 * exactly the size of "your contract was cancelled underneath you".
 *
 * `active` and the `waiting_*` states are deliberately absent: they
 * are reports on progress, they recur, and they are what class 2's
 * `lifecycle` level is for.
 */
const CLASS1_LIFECYCLE_STATES: ReadonlySet<SpineContractState> = new Set([
  'done',
  'cancelled',
  'superseded',
  'parked',
]);

/** How many pages the sweep will walk in one tick before deferring the rest. */
const SWEEP_MAX_PAGES = 20;
const SWEEP_PAGE_SIZE = 500;

export interface CuratorOptions {
  annex: AnnexStore;
  store: CuratorStore;
  broker: Broker;
  logger: Logger;
  /** Injected everywhere. There is no `Date.now()` below this line. */
  now?: () => number;
  /**
   * THE PHONE, and the one place a spine event reaches it.
   *
   * Given the SAME message the class-1 broker push already produced, so
   * there is no second push path — this rides the existing VAPID /
   * `shouldPush` machinery, extended, not a parallel one. Called ONLY
   * for a class-1 delivery whose kind is on the member's interrupt
   * whitelist; `shouldPush` then applies the rest (never to a live
   * subscriber, never to the sender). Absent when the deployment has no
   * web push configured, in which case the queue still holds every item
   * — the whitelist gates the phone, never the queue.
   */
  phonePush?: (message: Message) => void;
}

export interface Curator {
  /**
   * A member read their pack. Grants leases on everything in it,
   * advances the receipt to the pack's cursor, and logs the class-0
   * spend — the pack landed in an album, and the ledger says whose and
   * how big.
   */
  onOrient(member: string, pack: OrientLike, bytes: number): void;
  /** Any read that PROVES the member took the stream in. Receipts only, never leases. */
  onRead(member: string, seq: number, via: ReceiptVia): void;
  /**
   * Post-commit on the single append path: renew the actor's lease
   * (their own write proves they hold what it names) and deliver
   * class 1 to whoever the event addressed.
   *
   * ONE CALL SITE, and it is an invariant rather than a coincidence.
   * `POST /spine/events` is the only place in the server that calls
   * `AnnexStore.append`, and this hook hangs off it; a second caller
   * would be a write whose addressees are never told, which is a
   * silence nobody would notice because the annex would look correct.
   * Phase 4's probe engine writes `observation` events and MUST route
   * through here rather than reaching the store directly — a probe
   * that discharges a `waiting_for` contract without telling its
   * assignee is the exact failure this class exists to prevent.
   * `spine-append-callers.test.ts` holds the invariant from outside.
   */
  onAppend(result: AppendResult): Promise<void>;
  /** A floor signal. Accelerant only — see the header. */
  onSignal(
    member: string,
    signal: SpineFloorSignal,
    capabilities?: SpineRunnerCapabilities,
  ): number;
  /** Time-driven work: batched class-2 deltas, then at most one nudge per member. */
  sweep(): Promise<void>;
  config(member: string): SpineCuratorConfigResponse;
  setSubscription(
    member: string,
    contract: string,
    level: SpineSubscriptionLevel,
    updatedBy: string,
  ): void;
  setPolicy(
    member: string,
    patch: {
      leaseTtlMs?: number;
      nudgeMinIntervalMs?: number;
      interruptWhitelist?: SpineEventKind[];
    },
    updatedBy: string,
  ): void;
  injections(query: ListSpineInjectionsQuery & { member: string }): SpineInjection[];
}

/** Just enough of `OrientPack` for the curator to lease and account for it. */
export interface OrientLike {
  cursor: number;
  contracts: readonly { contract: string }[];
  asksForMe: readonly { id: string }[];
  myOpenAsks: readonly { id: string }[];
}

/**
 * One class-1 recipient, and why. `detail` is the one extra clause a
 * kind may carry when an id and a title do not locate the act — a
 * deliberate hole in "no full re-sends", sized to one required field.
 */
interface AddressedTarget {
  member: string;
  why: string;
  detail?: string;
}

/** One member's share of a sweep tick's class-2 traffic. */
interface DeltaBatch {
  /** Contract id → the events that qualified, oldest first. */
  byContract: Map<string, SpineEvent[]>;
}

class SpineCurator implements Curator {
  private readonly annex: AnnexStore;
  private readonly store: CuratorStore;
  private readonly broker: Broker;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly phonePush: ((message: Message) => void) | undefined;
  /**
   * How far class 2 has been swept.
   *
   * Initialised to the annex head at CONSTRUCTION, not to zero. A
   * restart must not replay every delta since the beginning of the
   * team as though it had just happened — class 2 is the class that
   * yields, and a flood of stale "what changed" lines is precisely the
   * spend it exists to avoid. The cost of the choice is bounded and
   * known: deltas that were in flight across the restart are lost, and
   * the member's next `orient` carries them anyway.
   */
  private sweptSeq: number;
  /**
   * Declared runner capabilities, per member, IN MEMORY ON PURPOSE.
   *
   * These are the ceiling. Persisting them would create a durable
   * record that something correctness-bearing could one day be tempted
   * to read ("this member's runner declares a dump signal, so we can
   * relax the lease TTL"), and the moment anything does, the spine's
   * correctness varies by vendor release. A map that a restart empties
   * makes the rule structural rather than a comment: nothing can
   * depend on a fact that routinely disappears.
   */
  private readonly capabilities = new Map<string, SpineRunnerCapabilities>();

  constructor(options: CuratorOptions) {
    this.annex = options.annex;
    this.store = options.store;
    this.broker = options.broker;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.phonePush = options.phonePush;
    this.sweptSeq = this.headSeq();
  }

  // ─── Class 0 — recovery ─────────────────────────────────────────

  onOrient(member: string, pack: OrientLike, bytes: number): void {
    const now = this.now();
    const refs = [
      ...pack.contracts.map((c) => c.contract),
      ...pack.asksForMe.map((a) => a.id),
      ...pack.myOpenAsks.map((a) => a.id),
    ];
    // The lease is granted even when the pack is EMPTY. A member with
    // nothing on their plate has been told so, and that is a real
    // state — the empty-plate skip on the old re-brief path is the
    // documented defect this replaces, and reproducing it here would
    // mean a member with no contracts could never hold a lease and so
    // could never stop being a nudge candidate.
    this.store.grantLeases(member, refs, pack.cursor, 'orient', now);
    this.store.advanceReceipt(member, pack.cursor, 'orient', now);
    this.provenLive(member);
    this.store.logInjection({
      member,
      class: 0,
      kind: 'recovery_pack',
      refs,
      cursor: pack.cursor,
      bytes,
      // The pack reached the caller in the HTTP response. There is no
      // separate sink to confirm at — the read IS the delivery.
      delivered: true,
      at: now,
    });
  }

  onRead(member: string, seq: number, via: ReceiptVia): void {
    this.store.advanceReceipt(member, seq, via, this.now());
    this.provenLive(member);
  }

  /**
   * The member is demonstrably there: they read, they wrote, or their
   * runner bracketed a session. That starts a NEW LEASE EPOCH, so the
   * one nudge a stale lease buys is available again.
   *
   * Without it, a nudge attempted at an offline member was spent
   * forever. `nudged_at` is cleared only by a lease grant, and a grant
   * requires a CONFIRMED delivery — so the member who could not be
   * reached is precisely the member who is never reached again. The
   * population that fails that way is the opaque runner the whole
   * design is for: no signals, offline between sessions, and after one
   * missed push, permanently dark.
   *
   * §6 grants one nudge per lease epoch. A member's return is a new
   * epoch; it is not the same silence continuing.
   */
  private provenLive(member: string): void {
    this.store.rearmNudges(member);
  }

  // A NOTE ON WHAT `provenLive` MAY NOT DO, because the first version
  // of it did: it re-arms UNDELIVERED nudges and nothing else, and it
  // does not touch the cadence floor. Widening it to every spent nudge
  // turns each proof of liveness into permission to nudge again, so a
  // member writing steadily is nudged on every sweep tick past a
  // lease's TTL — the dead objective-context watchdog, rebuilt. The
  // narrow lever is the whole fix; the intent (an offline member who
  // returns is reachable again) is unchanged.

  // ─── Class 1 — addressed ────────────────────────────────────────

  async onAppend(result: AppendResult): Promise<void> {
    // A replay is the SAME event resolving a second time. Injecting
    // again would spend a member's album on a retry that, by
    // construction, changed nothing — and the idempotency guarantee
    // would hold for the annex while quietly failing for attention.
    if (result.replayed) return;
    const now = this.now();
    const event = result.event;

    // The write path is the floor. A member's own append proves they
    // hold what it names, so it renews their lease for free — no
    // round trip, no signal, no runner cooperation of any kind.
    if (event.contract !== null) {
      this.store.grantLeases(event.actor, [event.contract], event.seq, 'act', now);
    }
    // A write proves liveness even when it names no contract: whoever
    // sent it is there, holding a session, able to be reached.
    this.provenLive(event.actor);

    for (const target of addressedMembers(event, result.contract, this.annex)) {
      if (target.member === event.actor) continue;
      await this.deliverAddressed(target, event, result.contract, now);
    }
  }

  private async deliverAddressed(
    target: AddressedTarget,
    event: SpineEvent,
    contract: SpineContract | null,
    now: number,
  ): Promise<void> {
    const member = target.member;
    const cursor = this.store.receipt(member)?.seq ?? 0;
    const body = renderAddressed(event, contract, target, cursor);
    const { delivered, message } = await this.push(member, body, 1, event.id);
    // The ref is the contract when there is one — a lease is a claim
    // about a thing that goes stale, and an event never does.
    const refs = [event.contract ?? event.id];
    if (delivered) this.store.grantLeases(member, refs, event.seq, 'class1', now);
    this.store.logInjection({
      member,
      class: 1,
      kind: 'addressed',
      refs,
      cursor,
      bytes: body.length,
      delivered,
      at: now,
    });
    this.logger.info('spine: class-1 injection', {
      member,
      event: event.id,
      kind: event.kind,
      contract: event.contract,
      bytes: body.length,
      delivered,
    });

    // THE PHONE, gated by the interrupt whitelist — the only place a
    // spine event reaches one. The queue already holds this event
    // (that is a free read) and a live session already got the line
    // above; this decides only whether it ALSO buzzes a phone, which is
    // the rarest budget. `shouldPush` inside `phonePush` applies the
    // rest — never to a live subscriber, never to the sender — so a
    // whitelisted kind that the member is sitting in front of still does
    // not buzz. A kind off the list is not silenced; it is un-buzzed.
    if (message !== null && this.phonePush !== undefined) {
      const whitelist = this.store.policy(member).interruptWhitelist;
      if (whitelist.includes(event.kind)) {
        this.phonePush(message);
        this.logger.info('spine: class-1 phone', {
          member,
          event: event.id,
          kind: event.kind,
        });
      }
    }
  }

  // ─── Floor signals ──────────────────────────────────────────────

  onSignal(
    member: string,
    signal: SpineFloorSignal,
    capabilities?: SpineRunnerCapabilities,
  ): number {
    const now = this.now();
    if (signal === 'session_start' && capabilities !== undefined) {
      this.capabilities.set(member, capabilities);
    }
    // EVERY signal invalidates, including `bridge_connect` and
    // `session_start`. A fresh attachment is a context this server has
    // handed nothing to yet; treating "they just arrived" as evidence
    // that they still hold last week's pack is the one inference the
    // lease model exists to refuse.
    const ttlMs = this.store.policy(member).leaseTtlMs;
    const invalidated = this.store.invalidateLeases(member, signal, now, ttlMs);
    // A signal is a runner saying "I am here" about a context that has
    // changed. That is liveness, so it opens a new epoch — which is
    // also what makes a returning member who was nudged into the void
    // reachable again.
    this.provenLive(member);
    this.logger.info('spine: floor signal', { member, signal, leasesInvalidated: invalidated });
    return invalidated;
  }

  // ─── The sweep ──────────────────────────────────────────────────

  async sweep(): Promise<void> {
    await this.sweepDeltas();
    await this.sweepNudges();
  }

  /**
   * Class 2, batched PER MEMBER PER TICK.
   *
   * Batching per event would let one busy contract turn a `lifecycle`
   * subscription into a firehose, which is finding 1 of #155 wearing a
   * new schema. Batching per member (rather than per member per
   * contract) is the stronger form: a member watching six contracts
   * that all moved in the same tick gets one line, not six.
   */
  private async sweepDeltas(): Promise<void> {
    const now = this.now();
    const events = this.drainNewEvents();
    if (events.length === 0) return;

    // The team's focus set, as it stands at this tick — the third arm of
    // class-3 silence (parked ∪ waiting_for ∪ OUT-OF-FOCUS), the hole
    // phase 3 left open now closed. It is INERT when nothing is lit: an
    // empty set means the team has not adopted focus, so class 2 flows
    // for every contract exactly as before — which is why every phase-3
    // guarantee is preserved unchanged. Once anything is lit, the focus
    // set is the boundary: a contract outside it goes parked-shaped for
    // attention, generating no class-2 traffic while staying fully in
    // the annex. Class 1 is not touched here and never consults focus —
    // an ask that names you reaches you out of focus.
    const focusSet = new Set(this.annex.focusSet());
    const focusActive = focusSet.size > 0;

    // Contract → its state as of the last event BEFORE this window.
    // Silence is about the state a contract was sitting in when an
    // event arrived, not the state it ended up in: the lifecycle event
    // that parks a contract must reach its subscribers, and everything
    // after it must not.
    const stateAtArrival = new Map<string, SpineContractState>();
    const batches = new Map<string, DeltaBatch>();

    for (const event of events) {
      const contractId = event.contract;
      if (contractId === null) continue;
      if (SPINE_EVENT_CLASSES[event.kind] !== 'authoritative') continue;
      const contract = this.annex.contract(contractId);
      if (contract === null) continue;

      let state = stateAtArrival.get(contractId);
      if (state === undefined) {
        state = this.stateBefore(contractId, event.seq);
        stateAtArrival.set(contractId, state);
      }
      const outOfFocus = focusActive && !focusSet.has(contractId);
      const silenced = SILENT_STATES.has(state) || outOfFocus;
      if (event.kind === 'lifecycle') {
        stateAtArrival.set(contractId, (event.body as SpineLifecycleBody).state);
      }
      if (silenced) continue;

      // A member whose class-1 line already carried this event does
      // not also get a class-2 line about it. Computed from the event
      // rather than read back out of the ledger, so the two classes
      // agree by construction instead of by a join.
      const addressed = new Set(addressedMembers(event, contract, this.annex).map((t) => t.member));

      for (const candidate of this.class2Candidates(contract)) {
        if (candidate.member === event.actor) continue;
        if (addressed.has(candidate.member)) continue;
        if (!qualifies(candidate.level, event)) continue;
        let batch = batches.get(candidate.member);
        if (batch === undefined) {
          batch = { byContract: new Map() };
          batches.set(candidate.member, batch);
        }
        const list = batch.byContract.get(contractId) ?? [];
        list.push(event);
        batch.byContract.set(contractId, list);
      }
    }

    for (const [member, batch] of batches) {
      const cursor = this.store.receipt(member)?.seq ?? 0;
      const body = renderDeltaBatch(batch, this.annex, cursor);
      const refs = [...batch.byContract.keys()];
      // Class 2 never buzzes a phone — subscription deltas yield to the
      // member's budget, and the phone is the least yielding budget
      // there is. Only class-1 addressed deliveries reach it, gated.
      const { delivered } = await this.push(member, body, 2, refs.join(','));
      if (delivered) {
        const seq = Math.max(...[...batch.byContract.values()].flat().map((event) => event.seq));
        this.store.grantLeases(member, refs, seq, 'class2', now);
      }
      this.store.logInjection({
        member,
        class: 2,
        kind: 'subscription_delta',
        refs,
        cursor,
        bytes: body.length,
        delivered,
        at: now,
      });
      this.logger.info('spine: class-2 injection', {
        member,
        contracts: refs.length,
        events: [...batch.byContract.values()].reduce((n, list) => n + list.length, 0),
        bytes: body.length,
        delivered,
      });
    }
  }

  /**
   * One nudge, once, and only when there is something to be nudged
   * ABOUT.
   *
   * An expired lease on its own is not news — it means nobody has
   * spoken to this member for a while, which is the healthy case.
   * Nudging on that alone would ping every idle member every TTL
   * forever, which is the dead objectives watchdog rebuilt with better
   * tables.
   *
   * So it takes BOTH counters, and they are deliberately different
   * counters. The LEASE says "we have stopped assuming you still hold
   * this"; the RECEIPT says "here is how far you have demonstrably
   * read". A nudge is warranted exactly where those disagree with the
   * annex: the assumption has lapsed AND there is authoritative
   * movement the member has never read. Driving it off the lease's own
   * seq instead would mean a member who is pushed a class-1 line and
   * then loses their context is never nudged — the push moved the
   * lease, and pushes are precisely what must not count as reading.
   */
  private async sweepNudges(): Promise<void> {
    const now = this.now();
    // Out-of-focus work is silent for nudges too, so a member is never
    // nudged into oblivion about a contract the team has parked
    // attention-wise. Computed once per sweep and inert while nothing is
    // lit, so the phase-3 nudge bound holds unchanged — and holds on an
    // out-of-focus contract, which generates no nudge at all.
    const focusSet = new Set(this.annex.focusSet());
    const focusActive = focusSet.size > 0;
    const byMember = new Map<string, LeaseRecord[]>();
    for (const lease of this.store.leases()) {
      const list = byMember.get(lease.member) ?? [];
      list.push(lease);
      byMember.set(lease.member, list);
    }

    for (const [member, leases] of byMember) {
      const policy = this.store.policy(member);
      const lastNudge = this.store.lastNudgeAt(member);
      if (lastNudge !== null && now - lastNudge < policy.nudgeMinIntervalMs) continue;
      const readTo = this.store.receipt(member)?.seq ?? 0;

      const stale = leases.filter(
        (lease) =>
          lease.nudgedAt === null &&
          this.store.leaseState(lease, policy.leaseTtlMs, now) !== 'live' &&
          this.hasUnreadMovement(lease, readTo, focusSet, focusActive),
      );
      if (stale.length === 0) continue;

      const cursor = this.store.receipt(member)?.seq ?? 0;
      const body = renderNudge(
        stale.map((lease) => this.annex.contract(lease.ref)),
        stale.map((lease) => lease.ref),
        cursor,
      );
      const { delivered } = await this.push(member, body, 0, 'nudge');
      // Spent whether or not it landed — "at most one" has to mean at
      // most one ATTEMPT, or a nudge that failed to deliver and is
      // retried next tick is a nudge that repeats.
      //
      // But WHETHER it landed is recorded, because it decides one
      // thing: only an undelivered nudge is re-armed when the member
      // later proves liveness. A delivered nudge is spent for its
      // epoch and only a lease re-grant resets it.
      this.store.markNudged(
        member,
        stale.map((lease) => lease.ref),
        now,
        delivered,
      );
      this.store.logInjection({
        member,
        class: 0,
        kind: 'recovery_nudge',
        refs: stale.map((lease) => lease.ref),
        cursor,
        bytes: body.length,
        delivered,
        at: now,
      });
      this.logger.info('spine: recovery nudge', {
        member,
        leases: stale.length,
        delivered,
      });
    }
  }

  private hasUnreadMovement(
    lease: LeaseRecord,
    readTo: number,
    focusSet: ReadonlySet<string>,
    focusActive: boolean,
  ): boolean {
    const contract = this.annex.contract(lease.ref);
    // A lease on an ask, not a contract. Asks reach their holder
    // through class 1, which never yields and never waits for a sweep.
    if (contract === null) return false;
    if (SILENT_STATES.has(contract.state)) return false;
    // Out-of-focus is the third silence, applied to nudges as it is to
    // class 2: no nudge about work the team has parked attention on.
    if (focusActive && !focusSet.has(contract.id)) return false;
    const page = this.annex.events({
      contract: lease.ref,
      since_seq: readTo,
      limit: SWEEP_PAGE_SIZE,
    });
    return page.events.some((event) => SPINE_EVENT_CLASSES[event.kind] === 'authoritative');
  }

  // ─── Policy as data ─────────────────────────────────────────────

  config(member: string): SpineCuratorConfigResponse {
    const authored = new Map(
      this.store.subscriptionsOfMember(member).map((row) => [row.contract, row]),
    );
    const subscriptions: SpineSubscription[] = [];
    for (const contract of this.annex.contracts({ member })) {
      subscriptions.push(authored.get(contract.id) ?? derivedSubscription(member, contract));
      authored.delete(contract.id);
    }
    // Authored rows for contracts this member is not bound to are
    // still theirs and are still reported. A level someone chose that
    // the config screen does not show is a level they cannot unset.
    for (const row of authored.values()) subscriptions.push(row);
    subscriptions.sort((a, b) => a.contract.localeCompare(b.contract));
    return {
      member,
      subscriptions,
      policy: this.store.policy(member),
      capabilities: this.capabilities.get(member) ?? null,
    };
  }

  setSubscription(
    member: string,
    contract: string,
    level: SpineSubscriptionLevel,
    updatedBy: string,
  ): void {
    this.store.setSubscription(member, contract, level, updatedBy, this.now());
  }

  setPolicy(
    member: string,
    patch: {
      leaseTtlMs?: number;
      nudgeMinIntervalMs?: number;
      interruptWhitelist?: SpineEventKind[];
    },
    updatedBy: string,
  ): void {
    this.store.setPolicy(member, patch, updatedBy, this.now());
  }

  injections(query: ListSpineInjectionsQuery & { member: string }): SpineInjection[] {
    return this.store.injections(query);
  }

  // ─── Plumbing ───────────────────────────────────────────────────

  /**
   * ONE `broker.push` per injection, addressed to one member.
   *
   * `delivery.live` — not `targets` — is what a lease is granted on.
   * `targets` counts registered members; `live` counts sinks that
   * actually took the message. A lease recorded on `targets` would be
   * a claim that an offline member holds something nothing ever
   * handed them.
   */
  private async push(
    member: string,
    body: string,
    injectionClass: 0 | 1 | 2,
    ref: string,
  ): Promise<{ delivered: boolean; message: Message | null }> {
    try {
      const result = await this.broker.push(
        {
          to: member,
          title: 'spine',
          body,
          level: 'info',
          data: { kind: 'spine_injection', class: injectionClass, ref },
        },
        { from: 'csuite' },
      );
      // The message is returned WHOLE, delivered or not: an offline
      // member (`live === 0`) is precisely the one the phone push exists
      // for, so the phone gate must run on the message regardless of
      // whether a live session took it.
      return { delivered: result.delivery.live > 0, message: result.message };
    } catch (err) {
      this.logger.warn('spine: injection push failed', {
        member,
        class: injectionClass,
        error: err instanceof Error ? err.message : String(err),
      });
      return { delivered: false, message: null };
    }
  }

  private headSeq(): number {
    return this.annex.events({ limit: 1 }).headSeq;
  }

  /** Everything appended since the last tick, oldest first. Advances the cursor. */
  private drainNewEvents(): SpineEvent[] {
    const collected: SpineEvent[] = [];
    let cursor = this.sweptSeq;
    for (let page = 0; page < SWEEP_MAX_PAGES; page++) {
      const result = this.annex.events({ since_seq: cursor, limit: SWEEP_PAGE_SIZE });
      collected.push(...result.events);
      if (result.nextCursor === null) {
        cursor = result.headSeq;
        break;
      }
      cursor = result.nextCursor;
    }
    this.sweptSeq = cursor;
    return collected;
  }

  /** A contract's state immediately before `seq`, from its own lifecycle history. */
  private stateBefore(contractId: string, seq: number): SpineContractState {
    const page = this.annex.events({ contract: contractId, kind: 'lifecycle', limit: 500 });
    let state: SpineContractState = 'active';
    for (const event of page.events) {
      if (event.seq >= seq) break;
      state = (event.body as SpineLifecycleBody).state;
    }
    return state;
  }

  /**
   * Who class 2 might reach for this contract: everyone who authored a
   * row, plus the ORIGINATOR at `lifecycle` by default.
   *
   * The originator default is #155 finding 1's answer. The old system
   * fanned every objective event to everyone who touched it and gave
   * readers no control; the answer is not "fan out less" but "the
   * reader decides", with the one default that is almost always right
   * — the member who authored the contract wants to know when it moves
   * state, and nothing else, until they say otherwise.
   *
   * Assignee, verifier and authority are deliberately NOT defaulted
   * here. Everything that binds them arrives as class 1, which never
   * yields; giving them a class-2 default as well would spend their
   * album twice on the same fact.
   */
  private class2Candidates(
    contract: SpineContract,
  ): { member: string; level: SpineSubscriptionLevel }[] {
    const out = new Map<string, SpineSubscriptionLevel>();
    out.set(contract.createdBy, 'lifecycle');
    for (const row of this.store.subscriptionsForContract(contract.id)) {
      out.set(row.member, row.level);
    }
    return [...out].map(([member, level]) => ({ member, level }));
  }
}

/** The derived default for a member with no authored row on this contract. */
function derivedSubscription(member: string, contract: SpineContract): SpineSubscription {
  return {
    member,
    contract: contract.id,
    level: contract.createdBy === member ? 'lifecycle' : 'none',
    explicit: false,
    updatedBy: null,
    updatedAt: null,
  };
}

function qualifies(level: SpineSubscriptionLevel, event: SpineEvent): boolean {
  if (level === 'none') return false;
  if (level === 'all') return true;
  return event.kind === 'lifecycle';
}

/**
 * Who an event ADDRESSED, and why — the class-1 routing table, in one
 * exhaustive place.
 *
 * Written as a switch over the kind rather than as checks sprinkled
 * through the caller for the same reason `membersNamedBy` in the route
 * layer is: the failure mode is omission, and a table you have to pass
 * through is the only kind that notices a new kind arriving.
 */
function addressedMembers(
  event: SpineEvent,
  contract: SpineContract | null,
  annex: AnnexStore,
): AddressedTarget[] {
  switch (event.kind) {
    case 'ask': {
      const body = event.body as SpineAskBody;
      // `unblocks` rides along and nothing else does. It is required on
      // every ask precisely because an authority triaging a queue needs
      // to know what is stopped, and an ask with no contract — the
      // standing-authority shape — otherwise renders as "an ask, on no
      // contract", which is not identifiable at all. The question, the
      // context and the reasoning stay out: those are what `orient` is
      // for.
      return [
        {
          member: body.authority,
          why: 'names you as the authority',
          detail: `unblocks: ${body.unblocks}`,
        },
      ];
    }
    case 'criterion_verdict':
      return contract === null
        ? []
        : [{ member: contract.assignee, why: 'a verdict landed on your contract' }];
    case 'ruling': {
      const ask = annex.ask((event.body as SpineRulingBody).ask);
      return ask === null ? [] : [{ member: ask.asker, why: 'answers the ask you raised' }];
    }
    case 'ask_action': {
      const body = event.body as SpineAskActionBody;
      return body.action === 'redirect' && body.redirectTo !== undefined
        ? [{ member: body.redirectTo, why: 'an ask was redirected to you' }]
        : [];
    }
    case 'observation': {
      // THE DISCHARGE ARM (§7), and it SPLITS BY WHO ARMED THE CHECK.
      //
      // The asker always hears: they are the member who was blocked,
      // and the thing that unblocked them happened in the world rather
      // than in the annex, so nothing else would ever tell them.
      //
      // WHETHER THE AUTHORITY HEARS IS THE INTERESTING HALF, and the
      // first version got it wrong in a way worth writing down. It
      // addressed the asker alone, on the reasoning that a queue item
      // going away is the absence of a demand rather than a new one and
      // announcing it would be ceremony. That reasoning is true — of
      // the DEFER case, where the authority themselves attached the
      // trigger. It is false of the case that actually matters: the
      // ASKER armed the check, and the authority's queue item then
      // vanished, resolved, by a mechanism the authority never saw and
      // did not choose. Being silently released from a decision
      // somebody asked you to make is not the absence of news.
      //
      // The mechanism is legitimate — an asker has always been able to
      // withdraw the ask or `proceed` past it, and an ask carrying a
      // check is a BETTER record than a bare proceed, because the thing
      // that discharged it is a photograph anybody can go and look at.
      // So the answer is not to harden the gate; it is to tell the
      // person whose decision was taken off the table.
      //
      // WHO ARMED IT is read off the event, not off the check registry.
      // `authoredBy` on a probe's observation is the member whose
      // recipe fired, which is exactly the carrier event's actor. Going
      // to the registry would make the curator's routing depend on a
      // table the annex can be rebuilt without.
      if (!event.actor.startsWith('probe:') || event.staplesTo === null) return [];
      const stapled = annex.event(event.staplesTo);
      if (stapled === null || stapled.kind !== 'ask') return [];
      const ask = annex.ask(stapled.id);
      if (ask === null) return [];
      const targets: AddressedTarget[] = [
        {
          member: ask.asker,
          why: 'the check you armed fired — this ask is discharged, nobody had to answer it',
          detail: `ask ${ask.id} is ${ask.state}, resolved by this observation`,
        },
      ];
      if (event.authoredBy !== ask.authority && ask.authority !== ask.asker) {
        targets.push({
          member: ask.authority,
          why:
            'an ask you were asked to rule on discharged itself — the asker armed a check and ' +
            'the world answered it, so this is off your queue without you deciding anything',
          detail: `ask ${ask.id} is ${ask.state}, resolved by this observation`,
        });
      }
      return targets;
    }
    case 'proceeding': {
      // SOMEONE WENT AHEAD WITHOUT WAITING FOR THE RULING, and the
      // authority they were waiting on is the one who should hear it.
      //
      // The citation lock made proceeding a legitimate, typed act rather
      // than a silent one: an asker with an open ask may proceed past it
      // on the record instead of citing a ruling. But the AUTHORITY —
      // the member asked to make the call — was released from a decision
      // they never made, by a party who is not them. §9 names exactly
      // this ("a proceed on an irreversible subject") as an interrupt a
      // director should be able to opt into, and it is why `proceeding`
      // is on the default whitelist. The queue does not carry it (a
      // proceeding is not an ask awaiting a ruling), so a class-1 line —
      // and, if whitelisted, a phone buzz — is the only way they learn.
      const ask = annex.ask((event.body as SpineProceedingBody).ask);
      return ask === null
        ? []
        : [
            {
              member: ask.authority,
              why: 'someone proceeded past your ask without waiting for a ruling',
              detail: `ask ${ask.id} is still ${ask.state}`,
            },
          ];
    }
    case 'lifecycle': {
      const state = (event.body as SpineLifecycleBody).state;
      if (!CLASS1_LIFECYCLE_STATES.has(state) || contract === null) return [];
      const why =
        state === 'parked'
          ? 'this contract was parked — stop work on it'
          : `this contract is ${state} — it wants no more work`;
      const targets: AddressedTarget[] = [{ member: contract.assignee, why }];
      // The verifier is addressed only when one is NAMED. A contract
      // with no verifier has nobody holding that obligation, and
      // inventing a recipient is how a queue fills with items nobody
      // owns.
      if (contract.verifier !== null && contract.verifier !== contract.assignee) {
        targets.push({ member: contract.verifier, why });
      }
      return targets;
    }
    default:
      return [];
  }
}

/**
 * The class-1 line.
 *
 * WHAT IS NOT HERE IS THE POINT. No criteria, no outcome, no question
 * text, no reasoning — #155 finding 1 measured the cost of re-sending
 * a whole objective on every event, and the answer is that an id, a
 * title and what changed suffice. The member holds a pointer and the
 * cheapest call in the system; anything more is spending their album
 * to save them a tool call they were going to make anyway.
 */
function renderAddressed(
  event: SpineEvent,
  contract: SpineContract | null,
  target: AddressedTarget,
  cursor: number,
): string {
  // WHERE, and it must never be nothing. A contract when there is one;
  // otherwise the subject, which is the only other thing that locates
  // an act in the world. "On no contract" was a line a member could not
  // act on and could not tell apart from any other such line.
  const where =
    contract !== null
      ? `${contract.id} "${contract.title}" [${contract.state}, state_rev ${contract.stateRev}]`
      : event.contract !== null
        ? `contract ${event.contract}`
        : event.subject !== null
          ? `subject ${event.subject}`
          : 'no contract or subject named';
  const detail = target.detail === undefined ? '' : ` ${target.detail}.`;
  return (
    `spine: ${event.kind} ${event.id} by ${event.actor} — ${target.why}. On ${where}.${detail} ` +
    `Since seq ${cursor}: run \`orient\` for the pack, or \`annex_read since_seq=${cursor}\`.`
  );
}

/** The class-2 line: counts and titles, one entry per contract, then the cursor. */
function renderDeltaBatch(batch: DeltaBatch, annex: AnnexStore, cursor: number): string {
  const lines: string[] = ['spine: changes on contracts you subscribe to.'];
  for (const [contractId, events] of batch.byContract) {
    const contract = annex.contract(contractId);
    const title = contract === null ? '' : ` "${contract.title}"`;
    const state = contract === null ? '' : ` [${contract.state}, state_rev ${contract.stateRev}]`;
    const kinds = [...new Set(events.map((event) => event.kind))].join(', ');
    lines.push(
      `  ${contractId}${title}${state} — ${events.length} event(s): ${kinds} ` +
        `(through seq ${Math.max(...events.map((event) => event.seq))})`,
    );
  }
  lines.push(
    `Since seq ${cursor}: \`annex_read since_seq=${cursor}\`, or \`orient\` for the whole pack.`,
  );
  return lines.join('\n');
}

/**
 * The entire budget an expired lease buys: one line, pointing at the
 * cheapest call in the system. Never the pack — pushing a pack at a
 * member who may not need it is the forced insertion §10 forbids, and
 * the member is the only one who knows whether they need it.
 */
function renderNudge(
  contracts: readonly (SpineContract | null)[],
  refs: readonly string[],
  cursor: number,
): string {
  // NAMES WHAT MOVED. A bare count — "2 things you were holding have
  // moved" — is a line a member cannot triage: they cannot tell the
  // contract they are mid-way through from one they parked last week,
  // so the cheapest correct response to it is always to re-orient,
  // which spends a whole pack answering a question one line could
  // have. The refs are already in hand — they are what the ledger row
  // records — so spending them on the ledger while telling the member
  // a number was strictly worse than free.
  //
  // Ids and titles only. No outcome, no result, no criteria: the
  // no-re-send rule stands, and this is still a POINTER.
  const lines = refs.map((ref, i) => {
    const contract = contracts[i] ?? null;
    return contract === null ? `  ${ref}` : `  ${contract.id} "${contract.title}"`;
  });
  return (
    `spine: ${refs.length} thing(s) you were holding have moved since you last read:\n` +
    `${lines.join('\n')}\n` +
    `Run \`orient\` when convenient — cursor ${cursor}.`
  );
}

export function createCurator(options: CuratorOptions): Curator {
  return new SpineCurator(options);
}
