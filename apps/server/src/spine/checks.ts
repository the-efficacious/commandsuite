/**
 * Reading a recipe out of the event that carries it.
 *
 * §7's `check` is `{ subject, recipe, predicate, armed_by, authored_by }`
 * and §5's tool table has no `check_author`. Both of those are one
 * decision: A CHECK IS AUTHORED AS PART OF THE THING IT DISCHARGES.
 * An ask carries `trigger`/`check`; a `lifecycle` moving a contract to
 * `waiting_for(event, check)` carries the same pair under different
 * names; an `ask_action{defer}` carries a `trigger` (§9 — "attach a
 * trigger; it returns armed"). A check that could be authored on its
 * own would be a check that could outlive its reason, and the thing it
 * was for could be withdrawn without taking it along.
 *
 * SO THE RECIPE ARRIVES AS A STRING, because those fields were typed as
 * prose in phase 2 and are stored in permanent events. That constrains
 * the answer more than it looks:
 *
 *   JSON, NOT A GRAMMAR. A field whose first non-space character is `{`
 *   is a recipe declaration and is validated as one; anything else is
 *   the prose it has always been, describing a trigger to the humans
 *   reading the ask. A surface syntax of my own (`webhook:github when
 *   check_run.conclusion == success`) would have been a second
 *   predicate language wearing a nicer hat, with its own quoting rules,
 *   its own escaping bugs and its own edge cases around `exists` — for
 *   a member population that writes JSON fluently.
 *
 *   THE PREDICATE IS THE INBOX'S. `when` is `NotificationFilterRule[]`,
 *   evaluated by `applyFilters` verbatim. The webhook inbox has been
 *   deciding "does this payload match" since it shipped, over exactly
 *   these payloads. Reusing it is not code thrift; it is refusing to
 *   make a member ask which dialect they are in.
 *
 * PROSE IS NEVER A REFUSAL, and a malformed recipe always is. Those are
 * the two halves of one rule. A member writing "when CI goes green"
 * gets what phase 2 gave them — the ask lands, nothing is armed,
 * nothing was promised. A member writing `{"kind":"http_poll",...}` has
 * asked the system to press a button and is refused at the keyboard if
 * the instruction cannot be carried out. A pin checked later would fail
 * silently, hours on, into a log — and a check that quietly never fires
 * is indistinguishable from a world that never did the thing.
 */

import { SpineCheckRecipeSchema } from 'csuite-sdk/schemas';
import type {
  SpineAskActionBody,
  SpineAskBody,
  SpineCheckCarrier,
  SpineCheckRecipe,
  SpineEventKind,
  SpineLifecycleBody,
} from 'csuite-sdk/types';
import { SpineError } from './errors.js';

/** What the carrier said, before anyone decided whether it was a recipe. */
export interface CarrierFields {
  carrier: SpineCheckCarrier;
  /**
   * Candidate texts, in reading order.
   *
   * `check` before `trigger` because when a carrier has both, `check`
   * is the field named after the thing (§8's `waiting_for(event,
   * check)`), and `trigger` is where an `ask_action{defer}` puts it
   * because that action has no `check` field at all.
   */
  candidates: (string | undefined)[];
}

/**
 * Which fields of which kinds can carry a recipe.
 *
 * A table rather than checks sprinkled through the callers, for the
 * reason the curator's class-1 table is one: the failure mode is
 * omission, and a table you have to pass through is the only kind that
 * notices a new carrier arriving.
 */
export function carrierFields(kind: SpineEventKind, body: unknown): CarrierFields | null {
  if (kind === 'ask') {
    const ask = body as SpineAskBody;
    return { carrier: 'ask', candidates: [ask.check, ask.trigger] };
  }
  if (kind === 'ask_action') {
    const action = body as SpineAskActionBody;
    // Only a DEFER re-arms. A withdraw/decline/redirect carries no
    // trigger by schema, and a redirect that armed a check would arm it
    // for a question the asker has not got back.
    if (action.action !== 'defer') return null;
    return { carrier: 'ask', candidates: [action.trigger] };
  }
  if (kind === 'lifecycle') {
    const life = body as SpineLifecycleBody;
    if (life.state !== 'waiting_for') return null;
    // NOT `event`. §8's `event` is what the contract is waiting on, in
    // the members' words; `check` is what will re-light it. Reading the
    // prose field as a fallback would arm a probe off a sentence.
    return { carrier: 'waiting_for', candidates: [life.check] };
  }
  return null;
}

/** A field declares a recipe when it opens with `{`. Everything else is prose. */
export function declaresRecipe(text: string | undefined): boolean {
  return text !== undefined && text.trimStart().startsWith('{');
}

/**
 * The recipe a carrier declared, or `null` when it declared prose.
 *
 * Throws `invalid_input` when a declaration cannot be honoured — that
 * is the http-URL pin, the interval floor, the unknown kind, and the
 * malformed predicate, all refused at the moment the member is present
 * to be told.
 */
export function readRecipe(fields: CarrierFields | null): SpineCheckRecipe | null {
  if (fields === null) return null;
  const declared = fields.candidates.find(declaresRecipe);
  if (declared === undefined) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(declared);
  } catch (err) {
    throw new SpineError(
      'invalid_input',
      'this check opens with `{`, so it is being read as a probe recipe, and it is not valid ' +
        `JSON: ${err instanceof Error ? err.message : String(err)}. Write a recipe object ` +
        '({"kind":"webhook","endpoint":"…","when":[…]} or {"kind":"http_poll","url":"https://…",' +
        '"intervalMs":300000,"when":[…]}), or write prose — a check that is prose arms nothing ' +
        'and is refused by nothing.',
    );
  }
  const parsed = SpineCheckRecipeSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new SpineError(
      'invalid_input',
      `this probe recipe cannot be armed as written: ${issues}. Nothing was armed, and the ` +
        'refusal is here rather than at fire time on purpose — a check that silently never ' +
        'fires cannot be told apart from a world that never did the thing.',
      { path: ['body', 'check'] } as never,
    );
  }
  return parsed.data as SpineCheckRecipe;
}

/**
 * What the observation this check produces will be OF.
 *
 * The event's own caption when it has one, else the contract's. An
 * observation is always of somewhere (`subject` is required on the
 * kind), so a carrier that resolves neither cannot arm anything — and
 * that, too, is refused at authoring rather than discovered later.
 */
export function recipeSubject(parts: {
  eventSubject: string | null;
  contractSubject: string | null;
}): string | null {
  return parts.eventSubject ?? parts.contractSubject;
}

/** The refusal for a recipe with nowhere to point. */
export function noSubjectForRecipe(kind: SpineEventKind): SpineError {
  return new SpineError(
    'invalid_input',
    `this ${kind} declares a probe recipe but names no subject and no contract, so the ` +
      'observation it would produce would be of nowhere. A flash is always OF somewhere: ' +
      'caption the event with a registered subject, or name the contract whose subject it is.',
  );
}
