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
 * THE PROPERTY THIS FILE EXISTS TO HOLD, above every other:
 *
 *   Kill every floor signal and the curator stays CORRECT — only
 *   slower to re-orient.
 *
 * Nothing here branches on a declared capability, and nothing here
 * waits for a signal before it will act. `onSignal` moves leases from
 * `live` to `invalidated`, which is the same place the clock moves
 * them to (`expired`) a while later, and both buy exactly one cheap
 * nudge. That is the whole of what a signal does. `spine-curator.test.ts`
 * drives the entire class/lease/receipt suite with ZERO signals
 * reported; `spine-curator-signals.test.ts` replays the same scenarios
 * with signals and asserts the end states are identical.
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
  SpineAskActionBody,
  SpineAskBody,
  SpineContract,
  SpineContractState,
  SpineCuratorConfigResponse,
  SpineEvent,
  SpineFloorSignal,
  SpineInjection,
  SpineLifecycleBody,
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
    patch: { leaseTtlMs?: number; nudgeMinIntervalMs?: number },
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
  }

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

    for (const target of addressedMembers(event, result.contract, this.annex)) {
      if (target.member === event.actor) continue;
      await this.deliverAddressed(target.member, event, result.contract, target.why, now);
    }
  }

  private async deliverAddressed(
    member: string,
    event: SpineEvent,
    contract: SpineContract | null,
    why: string,
    now: number,
  ): Promise<void> {
    const cursor = this.store.receipt(member)?.seq ?? 0;
    const body = renderAddressed(event, contract, why, cursor);
    const delivered = await this.push(member, body, 1, event.id);
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
      const silenced = SILENT_STATES.has(state);
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
      const delivered = await this.push(member, body, 2, refs.join(','));
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
          this.hasUnreadMovement(lease, readTo),
      );
      if (stale.length === 0) continue;

      const cursor = this.store.receipt(member)?.seq ?? 0;
      const body = renderNudge(stale.length, cursor);
      const delivered = await this.push(member, body, 0, 'nudge');
      // Spent whether or not it landed. A nudge that failed to deliver
      // and is retried next tick is a nudge that repeats, and "at most
      // one" has to mean at most one attempt — the member is offline,
      // and their next `orient` is a better recovery than a second
      // line into a sink nobody is reading.
      this.store.markNudged(
        member,
        stale.map((lease) => lease.ref),
        now,
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

  private hasUnreadMovement(lease: LeaseRecord, readTo: number): boolean {
    const contract = this.annex.contract(lease.ref);
    // A lease on an ask, not a contract. Asks reach their holder
    // through class 1, which never yields and never waits for a sweep.
    if (contract === null) return false;
    if (SILENT_STATES.has(contract.state)) return false;
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
    patch: { leaseTtlMs?: number; nudgeMinIntervalMs?: number },
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
  ): Promise<boolean> {
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
      return result.delivery.live > 0;
    } catch (err) {
      this.logger.warn('spine: injection push failed', {
        member,
        class: injectionClass,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
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
): { member: string; why: string }[] {
  switch (event.kind) {
    case 'ask':
      return [
        { member: (event.body as SpineAskBody).authority, why: 'names you as the authority' },
      ];
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
  why: string,
  cursor: number,
): string {
  const where =
    contract === null
      ? event.contract === null
        ? 'no contract'
        : `contract ${event.contract}`
      : `${contract.id} "${contract.title}" [${contract.state}, state_rev ${contract.stateRev}]`;
  return (
    `spine: ${event.kind} ${event.id} by ${event.actor} — ${why}. On ${where}. ` +
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
function renderNudge(leases: number, cursor: number): string {
  return (
    `spine: ${leases} thing(s) you were holding have moved since you last read. ` +
    `Run \`orient\` when convenient — cursor ${cursor}.`
  );
}

export function createCurator(options: CuratorOptions): Curator {
  return new SpineCurator(options);
}
