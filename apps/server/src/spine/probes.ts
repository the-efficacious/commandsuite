/**
 * The probe engine — the system pressing a button a member composed.
 *
 * §7 in one paragraph: the system cannot take photographs, because it
 * has no judgement about what matters. What a member CAN do is author a
 * recipe, and the system can press the button on schedule. Results land
 * as `observation` events with `actor: probe:<check-id>` and
 * `authored_by: <member>` — the member took the photo, the system held
 * the camera — and the caption says both, permanently, in the annex.
 *
 * WHAT ARRIVES HERE AND FROM WHERE:
 *
 *   onAppend    every committed annex write, through the ONE write path
 *               (`append.ts`). Arms checks their carriers declared;
 *               disarms checks whose carriers went away. The engine
 *               never reaches the store directly and never bypasses the
 *               curator: a probe that discharged a contract without the
 *               curator seeing it is the failure class 1 exists for.
 *   onDelivery  a webhook delivery the inbox VERIFIED. HMAC and the
 *               provider's dedupe have already run; a check never sees
 *               a payload the team has not accepted as genuine.
 *   sweep       the interval half, for `http_poll`.
 *
 * TWO DISCHARGE SHAPES, and they are not variations on one:
 *
 *   waiting_for   the observation lands, then a `lifecycle` back to
 *                 `active` CITING it, actored by the probe and
 *                 authored by the member. Nobody nagged, nobody had to
 *                 notice, and no human was in the loop at any point.
 *   ask           the observation lands STAPLED to the ask, and the
 *                 fold closes the ask as `discharged`. The authority's
 *                 queue item goes away without the authority typing —
 *                 §9's armed setting, where the human does the thing
 *                 and types nothing because the probe is the
 *                 confirmation. The asker gets one class-1 line.
 *
 * A PREDICATE THAT SAYS NO PRODUCES NOTHING. Not an observation with a
 * negative result, not a note in the stream: nothing. A photograph is
 * taken when the shot the member composed comes out, not on every
 * shutter test, and an annex full of "still not green" would be the
 * status-text wall §10 forbids, generated automatically. The only trace
 * is `last_evaluated_at` in the registry, which is bookkeeping.
 */

import type {
  ListSpineChecksQuery,
  SpineAskActionBody,
  SpineCheck,
  SpineCheckRecipe,
  SpineEvent,
  SpineHttpPollRecipe,
  SpineLifecycleBody,
  SpineRevisionInput,
  SpineRulingBody,
} from 'csuite-sdk/types';
import type { Logger } from '../logger.js';
import { applyFilters, getPath } from '../notifications/render.js';
import type { SecretsStore } from '../secrets.js';
import type { AnnexWritePath } from './append.js';
import { carrierFields, readRecipe, recipeSubject } from './checks.js';
import type { CheckStore } from './probe-store.js';
import type { AnnexStore, AppendResult } from './store.js';
import { PROBE_ACTOR_PREFIX } from './store.js';
import { ulid } from './ulid.js';

/**
 * How much of a triggering payload rides into the observation body.
 *
 * The slice is normally the paths the member's own predicate named,
 * which is small. This bounds the other case — an empty predicate,
 * where "relevant" is honestly the whole thing — so that arming a check
 * on "any delivery at all" cannot write a quarter-megabyte GitHub
 * payload into a permanent event.
 */
const PROBE_OUTPUT_MAX = 8 * 1024;

/** Outbound poll ceilings. A probe presses a button; it does not scrape. */
const POLL_TIMEOUT_MS = 10_000;
const POLL_BODY_MAX = 256 * 1024;
/** Header the resolved secret rides in when the recipe names no other. */
const DEFAULT_AUTH_HEADER = 'Authorization';

export interface ProbeEngine {
  /** Post-commit on the one write path: arm what was declared, disarm what went away. */
  onAppend(result: AppendResult): Promise<void>;
  /** A VERIFIED inbound delivery. Fires every armed webhook check whose predicate passes. */
  onDelivery(input: { endpoint: string; payload: unknown; at?: number }): Promise<void>;
  /** The interval half: every armed `http_poll` whose interval has elapsed. */
  sweep(): Promise<void>;
  checks(query?: ListSpineChecksQuery): SpineCheck[];
  check(id: string): SpineCheck | null;
  /**
   * Drop the registry and refold it from the event stream. The annex is
   * the only truth; everything here but `lastEvaluatedAt` is derivable.
   */
  rebuildChecks(): void;
}

export interface ProbeEngineOptions {
  write: AnnexWritePath;
  checks: CheckStore;
  logger: Logger;
  /** Resolves a poll's auth secret by slug, server-side. Absent ⇒ no authed polls. */
  secrets?: SecretsStore;
  /** Injected everywhere. There is no `Date.now()` below this line. */
  now?: () => number;
  /** Injected so the security pins are testable without a network. */
  fetchImpl?: typeof fetch;
}

/** What a poll came back with, or why it did not. */
type PollOutcome = { ok: true; payload: unknown } | { ok: false; reason: string };

class SpineProbeEngine implements ProbeEngine {
  private readonly write: AnnexWritePath;
  private readonly annex: AnnexStore;
  private readonly store: CheckStore;
  private readonly logger: Logger;
  private readonly secrets: SecretsStore | undefined;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  /** A sweep still running when the next tick arrives must not double-poll. */
  private sweeping = false;

  constructor(options: ProbeEngineOptions) {
    this.write = options.write;
    this.annex = options.write.store;
    this.store = options.checks;
    this.logger = options.logger;
    this.secrets = options.secrets;
    this.now = options.now ?? Date.now;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  checks(query: ListSpineChecksQuery = {}): SpineCheck[] {
    return this.store.list(query);
  }

  check(id: string): SpineCheck | null {
    return this.store.get(id);
  }

  // ─── Arming and disarming ───────────────────────────────────────

  async onAppend(result: AppendResult): Promise<void> {
    // A replay is the same event resolving a second time. Arming again
    // would point a second camera at one thing; the registry's UNIQUE
    // index would catch it, but a retry should not depend on a
    // constraint to be a no-op.
    if (result.replayed) return;
    this.applyEvent(result.event);
  }

  /**
   * The fold, and the only place a check is armed or disarmed.
   *
   * `onAppend` calls it with a freshly committed event; `rebuildChecks`
   * calls it with every event in the stream. One function for both is
   * what makes the rebuild trustworthy — a second implementation would
   * be a second set of rules that could disagree with the live one, and
   * the disagreement would show up as a registry that quietly changes
   * shape when someone rebuilds it.
   */
  private applyEvent(event: SpineEvent): void {
    switch (event.kind) {
      case 'ask':
        this.armFrom(event, { ask: event.id, contract: null });
        return;
      case 'ask_action': {
        const body = event.body as SpineAskActionBody;
        if (body.action === 'withdraw' || body.action === 'decline') {
          this.disarmAsk(
            body.ask,
            `the ask was ${body.action === 'withdraw' ? 'withdrawn' : 'declined'} (${event.id})`,
          );
          return;
        }
        // A REDIRECT LEAVES IT ARMED. The question is unchanged,
        // unanswered, and now in front of somebody else; the world
        // doing the thing still answers it.
        if (body.action !== 'defer') return;
        // §9: defer attaches a trigger and the ask comes back armed. A
        // fresh arming supersedes the previous one, so the "one answer"
        // property survives an ask that was deferred twice.
        this.disarmAsk(body.ask, `superseded by a new arming (${event.id})`);
        this.armFrom(event, { ask: body.ask, contract: null });
        return;
      }
      case 'ruling': {
        // The authority answered. There is nothing left for a probe to
        // confirm, and firing now would staple a photograph to a
        // question that was already settled by a member.
        this.disarmAsk((event.body as SpineRulingBody).ask, `the authority ruled (${event.id})`);
        return;
      }
      case 'lifecycle': {
        const body = event.body as SpineLifecycleBody;
        const contract = event.contract;
        if (contract === null) return;
        if (body.state === 'waiting_for') {
          this.armFrom(event, { ask: null, contract });
          return;
        }
        this.disarmContract(contract, `contract moved to ${body.state} (${event.id})`);
        return;
      }
      case 'observation': {
        // A probe's own firing, replayed. Live, `fire()` records this
        // itself; on a rebuild this is what recovers `fired` from the
        // stream, which is what makes the registry a projection.
        if (!event.actor.startsWith(PROBE_ACTOR_PREFIX)) return;
        const id = event.actor.slice(PROBE_ACTOR_PREFIX.length);
        if (this.store.get(id) === null) return;
        this.store.recordFire(id, event.id, event.at);
        return;
      }
      default:
        return;
    }
  }

  /** Materialise the check a carrier event declared, if it declared one. */
  private armFrom(
    event: SpineEvent,
    target: { ask: string | null; contract: string | null },
  ): void {
    const fields = carrierFields(event.kind, event.body);
    // The store validated this at authoring, so a throw here would mean
    // the annex holds an event the store would refuse today. Logged
    // rather than swallowed: it is a real inconsistency, and it must
    // not take the append down after the fact.
    let recipe: SpineCheckRecipe | null;
    try {
      recipe = readRecipe(fields);
    } catch (err) {
      this.logger.warn('spine: stored carrier holds an unarmable recipe', {
        event: event.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (recipe === null || fields === null) return;

    const contractSubject =
      target.contract !== null
        ? (this.annex.contract(target.contract)?.subject ?? null)
        : this.subjectOfAsk(target.ask);
    const subject = recipeSubject({ eventSubject: event.subject, contractSubject });
    if (subject === null) {
      this.logger.warn('spine: carrier declares a recipe with no subject', { event: event.id });
      return;
    }

    const check = this.store.arm({
      id: `chk_${ulid(Date.parse(event.at))}`,
      sourceEvent: event.id,
      carrier: fields.carrier,
      subject,
      contract: target.contract,
      ask: target.ask,
      recipe,
      // WHOSE RECIPE THIS IS: the actor of the carrier event. Not the
      // ask's authority, not the contract's assignee — the member who
      // wrote the recipe is the member the photograph is attributed to.
      authoredBy: event.actor,
      at: event.at,
    });
    this.logger.info('spine: check armed', {
      check: check.id,
      carrier: check.carrier,
      recipe: recipe.kind,
      subject,
      authoredBy: check.authoredBy,
    });
  }

  private subjectOfAsk(askId: string | null): string | null {
    if (askId === null) return null;
    const ask = this.annex.ask(askId);
    if (ask === null) return null;
    if (ask.subject !== null) return ask.subject;
    return ask.contract === null ? null : (this.annex.contract(ask.contract)?.subject ?? null);
  }

  private disarmAsk(askId: string, reason: string): void {
    for (const check of this.store.armedForAsk(askId)) {
      this.store.disarm(check.id, reason);
      this.logger.info('spine: check disarmed', { check: check.id, reason });
    }
  }

  private disarmContract(contractId: string, reason: string): void {
    for (const check of this.store.armedForContract(contractId)) {
      this.store.disarm(check.id, reason);
      this.logger.info('spine: check disarmed', { check: check.id, reason });
    }
  }

  // ─── The webhook trigger ────────────────────────────────────────

  async onDelivery(input: { endpoint: string; payload: unknown; at?: number }): Promise<void> {
    const at = input.at ?? this.now();
    for (const check of this.store.armedForEndpoint(input.endpoint)) {
      await this.evaluate(check, input.payload, `webhook ${input.endpoint}`, at);
    }
  }

  // ─── The interval trigger ───────────────────────────────────────

  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const at = this.now();
      for (const check of this.store.duePolls(at)) {
        if (check.recipe.kind !== 'http_poll') continue;
        const outcome = await this.poll(check.recipe, check.authoredBy);
        if (!outcome.ok) {
          // A FAILED POLL IS NOT A FALSE PREDICATE, and it is not a
          // fire either. The check stays armed — the world may be
          // reachable next tick — and the evaluation stamp moves so the
          // interval floor still holds against an endpoint that is
          // down.
          this.store.recordEvaluation(check.id, new Date(at).toISOString());
          this.logger.warn('spine: poll failed', { check: check.id, reason: outcome.reason });
          continue;
        }
        await this.evaluate(check, outcome.payload, `poll ${check.recipe.url}`, at);
      }
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * The outbound GET, with every pin the design names, in one place.
   *
   * Each of these is a decision about what a server may be talked into
   * doing on a member's behalf, and none of them is configurable:
   *
   *   https only          checked again here as well as at authoring.
   *                       The authoring check is what a member is told
   *                       about; this one is what holds if a row ever
   *                       arrives by another route.
   *   no redirects        `redirect: 'manual'`, and a 3xx is a failed
   *                       poll. A followed redirect is a URL the member
   *                       did not author, which is the system deciding
   *                       what to look at — and with an auth header
   *                       attached, it is a credential sent somewhere
   *                       nobody approved.
   *   size cap            read incrementally against a budget rather
   *                       than trusting `content-length`, which the
   *                       other end controls.
   *   no request body     GET, always. A probe observes; it does not
   *                       act on the world.
   *   secret by slug      resolved here, server-side, from the team's
   *                       secrets store. The recipe holds the NAME, and
   *                       the recipe is a permanent annex event: a
   *                       token written into one could never be
   *                       rotated, redacted, or unseen.
   *   as its AUTHOR       the slug is resolved through the authoring
   *                       member's own projection, so a probe can only
   *                       ever send a credential that member could have
   *                       sent by hand. Arming a check is not a way to
   *                       borrow somebody else's access.
   */
  private async poll(recipe: SpineHttpPollRecipe, author: string): Promise<PollOutcome> {
    let url: URL;
    try {
      url = new URL(recipe.url);
    } catch {
      return { ok: false, reason: 'the recipe URL does not parse' };
    }
    if (url.protocol !== 'https:') {
      return { ok: false, reason: `refusing to poll ${url.protocol}// — https only` };
    }

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (recipe.authSecret !== undefined) {
      const secret = this.resolveSecret(recipe.authSecret, author);
      if (secret === null) {
        return {
          ok: false,
          reason: `secret '${recipe.authSecret}' resolves to nothing for ${author}`,
        };
      }
      headers[recipe.authHeader ?? DEFAULT_AUTH_HEADER] = secret;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
      });
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }

    if (response.status >= 300 && response.status < 400) {
      return {
        ok: false,
        reason:
          `refused to follow a ${response.status} redirect to ` +
          `${response.headers.get('location') ?? 'an unnamed location'} — the URL is part of ` +
          'the authored check, and a followed redirect is one nobody authored',
      };
    }
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };

    const text = await this.readCapped(response);
    if (text === null) {
      return { ok: false, reason: `response exceeded ${POLL_BODY_MAX} bytes` };
    }
    try {
      return { ok: true, payload: JSON.parse(text) };
    } catch {
      return { ok: false, reason: 'response body is not JSON, so no predicate can address it' };
    }
  }

  private resolveSecret(slug: string, member: string): string | null {
    if (this.secrets === undefined) return null;
    const secret = this.secrets.getBySlug(slug);
    if (secret === null) return null;
    try {
      // THROUGH THE MEMBER'S OWN PROJECTION. `resolveFor` returns only
      // the secrets that member is entitled to — team-wide ones and the
      // ones bound to them — so a check cannot reach a credential its
      // author could not. Any other resolution would make arming a
      // probe a privilege-escalation surface with a permanent record.
      const env = this.secrets.resolveFor(member);
      return env[secret.envName] ?? null;
    } catch {
      return null;
    }
  }

  /** Read the body against a byte budget rather than trusting the sender's headers. */
  private async readCapped(response: Response): Promise<string | null> {
    const body = response.body;
    if (body === null) return '';
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      size += value.byteLength;
      if (size > POLL_BODY_MAX) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
  }

  // ─── Firing ─────────────────────────────────────────────────────

  /** Test the member's predicate, and fire only if the shot came out. */
  private async evaluate(
    check: SpineCheck,
    payload: unknown,
    source: string,
    at: number,
  ): Promise<void> {
    const iso = new Date(at).toISOString();
    const verdict = applyFilters(check.recipe.when, payload);
    if (!verdict.pass) {
      this.store.recordEvaluation(check.id, iso);
      return;
    }
    await this.fire(check, payload, source, iso);
  }

  /**
   * The fire, in the order the guarantees require.
   *
   * The CLAIM comes first and it is synchronous — before any `await`,
   * so two deliveries interleaving on the event loop cannot both take
   * it. Then the observation, through the shared write path so the
   * curator sees it. Then the discharge, whichever shape the carrier
   * asked for.
   */
  private async fire(
    check: SpineCheck,
    payload: unknown,
    source: string,
    at: string,
  ): Promise<void> {
    if (!this.store.claimForFiring(check.id)) return;

    const actor = `${PROBE_ACTOR_PREFIX}${check.id}`;
    let observation: SpineEvent;
    try {
      const revision = this.revisionFrom(check, payload, at);
      const result = await this.write.append(
        {
          kind: 'observation',
          subject: check.subject,
          // STAPLED to the ask, for an ask check. That is what closes
          // the authority's queue item with the evidence attached
          // rather than merely near it.
          ...(check.ask !== null ? { staplesTo: check.ask } : {}),
          ...(revision !== null ? { revision } : {}),
          // The provenance pair, and the whole of §7's honesty: the
          // actor is the camera, `authoredBy` is the photographer.
          authoredBy: check.authoredBy,
          body: {
            what: `check ${check.id}, armed by ${check.authoredBy}, fired on ${source}`,
            output: sliceOf(payload, check.recipe),
          },
        },
        { actor, now: Date.parse(at) },
      );
      observation = result.event;
    } catch (err) {
      const reason = `firing failed: ${err instanceof Error ? err.message : String(err)}`;
      this.store.failClaim(check.id, reason);
      this.logger.warn('spine: check fired but produced no observation', {
        check: check.id,
        error: reason,
      });
      return;
    }

    this.store.recordFire(check.id, observation.id, at);
    this.logger.info('spine: check fired', {
      check: check.id,
      observation: observation.id,
      authoredBy: check.authoredBy,
      subject: check.subject,
    });

    if (check.contract !== null) await this.relight(check, observation, at);
  }

  /**
   * The `waiting_for` discharge: back to `active`, citing the
   * observation, with nobody in the loop.
   *
   * Actored by the probe and authored by the member, which is the one
   * lifecycle shape a probe is entitled to append — the store fences it
   * on every side (only to `active`, only from `waiting_for`, only
   * citing this probe's own observation).
   */
  private async relight(check: SpineCheck, observation: SpineEvent, at: string): Promise<void> {
    const contract = this.annex.contract(check.contract as string);
    if (contract === null || contract.state !== 'waiting_for') {
      this.logger.info('spine: nothing to re-light', {
        check: check.id,
        contract: check.contract,
        state: contract?.state ?? 'missing',
      });
      return;
    }
    try {
      await this.write.append(
        {
          kind: 'lifecycle',
          opId: `probe-${check.id}-relight`,
          expectedStateRev: contract.stateRev,
          cites: [observation.id],
          authoredBy: check.authoredBy,
          body: {
            contract: contract.id,
            state: 'active',
            reason:
              `the check ${check.authoredBy} armed on this contract fired: ${observation.id}. ` +
              'The room did the thing that was being waited for.',
          },
        },
        { actor: `${PROBE_ACTOR_PREFIX}${check.id}`, now: Date.parse(at) },
      );
    } catch (err) {
      // The observation stands whatever happens here — it is a true
      // photograph of the world and nothing about a failed transition
      // makes it false. What is lost is the automatic re-lighting, and
      // the contract's assignee finds out at their next `orient`, which
      // is the same path every other staleness takes.
      this.logger.warn('spine: check fired but the contract did not re-light', {
        check: check.id,
        contract: contract.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private revisionFrom(check: SpineCheck, payload: unknown, at: string): SpineRevisionInput | null {
    const path = check.recipe.revisionPath;
    if (path === undefined) return null;
    const value = getPath(payload, path);
    if (value === undefined || value === null) return null;
    return {
      subject: check.subject,
      value: String(value),
      // OBSERVED, never asserted. The probe looked; nobody is
      // recounting what somebody else saw.
      how: 'observed',
      source: `${PROBE_ACTOR_PREFIX}${check.id}`,
      at,
    };
  }

  // ─── The rebuild ────────────────────────────────────────────────

  rebuildChecks(): void {
    this.store.clear();
    let since = 0;
    for (;;) {
      const page = this.annex.events({ since_seq: since, limit: 500 });
      if (page.events.length === 0) break;
      for (const event of page.events) this.applyEvent(event);
      since = page.events[page.events.length - 1]?.seq ?? since;
      if (page.events.length < 500) break;
    }
  }
}

/**
 * THE RELEVANT SLICE — the paths the member's own predicate named.
 *
 * A photograph is subject-bound and partial (axiom 2), and the honest
 * partial of a webhook payload is the part the recipe was about. It is
 * also the part a reader can check the claim against: "fired because
 * `check_run.conclusion` was `success`" is verifiable from the slice
 * and unverifiable from a summary.
 *
 * With no predicate at all, "relevant" is honestly the whole payload —
 * the member armed on any delivery — so the whole thing rides, bounded,
 * because an annex event is permanent.
 */
export function sliceOf(payload: unknown, recipe: SpineCheckRecipe): string {
  const paths = [...recipe.when.map((rule) => rule.path)];
  if (recipe.revisionPath !== undefined) paths.push(recipe.revisionPath);
  const unique = [...new Set(paths)];
  const slice =
    unique.length === 0
      ? payload
      : Object.fromEntries(unique.map((path) => [path, getPath(payload, path) ?? null]));
  let text: string;
  try {
    text = JSON.stringify(slice, null, 2) ?? String(slice);
  } catch {
    text = String(slice);
  }
  return text.length <= PROBE_OUTPUT_MAX
    ? text
    : `${text.slice(0, PROBE_OUTPUT_MAX)}\n… [truncated at ${PROBE_OUTPUT_MAX} bytes]`;
}

export function createProbeEngine(options: ProbeEngineOptions): ProbeEngine {
  return new SpineProbeEngine(options);
}
