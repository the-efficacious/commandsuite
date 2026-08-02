/**
 * Context packs — curated blocks of standing prose an operator can opt a
 * member into, composed into that member's `instructions` and carried into
 * the agent's system prompt by the existing briefing path.
 *
 * A pack is CONFIG-CLASS content: it states something durable about how this
 * member works, the same way the member's own instructions do. That is why it
 * belongs in the frozen prose rather than in message traffic, and why the
 * registry lives here in the SDK — the server composes it, the CLI and the web
 * UI offer it, and all three need the same ids, the same titles, and the same
 * bodies without any of them owning the text.
 *
 * WHY PACKS ARE OFF BY DEFAULT
 *
 * An agent that has not been told the machine is its own behaves like a guest.
 * It asks before installing anything, cleans up after itself, works around a
 * missing tool rather than adding it, and treats every file it did not create
 * as someone else's. That posture is correct on a human's laptop and wrong on a
 * box that exists only to run this agent — but the agent cannot tell the two
 * apart, so it defaults to the safe one.
 *
 * Telling it otherwise changes behavior more than any plumbing in this repo
 * does. It is a real grant, not a formatting preference: the agent will start
 * modifying system config and leaving state behind because you said it could.
 * A default that quietly does that to someone's machine would be indefensible,
 * so the packs ship off and the operator turns them on deliberately, per
 * member, with the pack's own prose visible before they click.
 *
 * ORDERING IS LOAD-BEARING. `composeInstructions` puts pack bodies FIRST and
 * the member's own instructions LAST, so on any surface that resolves
 * last-wins — which is how both claude's `--append-system-prompt` and codex's
 * `developerInstructions` are read in practice — a member-specific directive
 * overrides whatever a pack said. Packs are the floor, not the ceiling.
 */

/** One curated block of standing prose, addressable by a stable id. */
export interface ContextPack {
  /**
   * Stable slug, persisted on the member record. Never reuse an id for
   * different prose: a member row holding `'own-machine'` will pick up
   * whatever body ships under that id in the release they upgrade to.
   */
  id: string;
  /** Short label for the checkbox in the members admin UI. */
  title: string;
  /** One line under the checkbox — what turning this on actually does. */
  summary: string;
  /**
   * The prose composed into the member's instructions verbatim. Written as
   * direct second-person instruction to the agent, with no preamble and no
   * headers — the composer stitches blocks together and adds nothing.
   */
  body: string;
}

/**
 * The `own-machine` pack.
 *
 * Deliberately about POSTURE, never about layout. It has to read true on a
 * dedicated laptop, a bare VM, or a container, so it names no paths and no
 * provisioning mechanism — anything that describes a particular machine's
 * directory structure belongs in that machine's own login banner, not in prose
 * that ships to every member who ticks the box.
 */
const OWN_MACHINE_BODY = [
  `This machine is yours. It is not a human's laptop and it is not shared — nothing on this disk is someone else's working tree, and there is no one whose environment you might disturb by changing it. Treat the whole box as your own, because that is what it is.`,
  `You do not need to ask before installing tools or changing system config. If the work needs a compiler, a language runtime, a database, a profiler, a font — add it and move on. When something about the environment is in your way, the right instinct is to fix the environment rather than work around it.`,
  `Your home directory and the directories you work in persist between sessions. Notes you leave yourself, scripts you write, shell config you tune, and tools you install will still be here next time you start up. Nothing resets when a session ends.`,
  `So use that. Set the machine up the way you actually want to work: keep your own notes where you will find them again, build the small helpers you keep wishing you had, and leave the place better arranged than you found it. Everything you invest in the setup compounds across every session after this one.`,
].join('\n\n');

/**
 * Every pack this release ships. Order here is the order the UI lists them in.
 *
 * Removing a pack is safe by design: members still referencing its id keep
 * working, they just stop receiving the prose (see `composeInstructions`).
 */
export const CONTEXT_PACKS: readonly ContextPack[] = [
  {
    id: 'own-machine',
    title: 'Own machine',
    summary:
      'Tell the agent this machine belongs to it — install freely, change system config, and expect its setup to persist between sessions.',
    body: OWN_MACHINE_BODY,
  },
];

const PACKS_BY_ID: ReadonlyMap<string, ContextPack> = new Map(
  CONTEXT_PACKS.map((pack): [string, ContextPack] => [pack.id, pack]),
);

/** Look up a pack by id. Returns `null` for ids this release does not ship. */
export function getContextPack(id: string): ContextPack | null {
  return PACKS_BY_ID.get(id) ?? null;
}

/**
 * Compose a member's enabled packs with their own instructions into the single
 * string the briefing carries.
 *
 * Pack bodies come first, in the order the caller listed them; the member's own
 * instructions come last so they win on a last-wins read. Blocks are joined by
 * a blank line and nothing else — no headers, no separators, no labels. The
 * result is prose, and whatever composes it downstream is free to frame it.
 *
 * Unknown ids are skipped in silence rather than raising. A member record can
 * outlive the pack it names — an operator ticks a box, a later release drops
 * that pack, and the member's row still holds the id. Failing there would take
 * down that member's briefing, and with it their session, over prose that is
 * merely absent. Duplicate ids collapse to one block for the same reason: a
 * doubled entry is a bookkeeping accident, and repeating a paragraph in a
 * system prompt is strictly worse than not.
 */
export function composeInstructions(packIds: readonly string[], instructions: string): string {
  const blocks: string[] = [];
  const seen = new Set<string>();

  for (const id of packIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const pack = getContextPack(id);
    if (pack === null) continue;
    const body = pack.body.trim();
    if (body.length > 0) blocks.push(body);
  }

  const own = instructions.trim();
  if (own.length > 0) blocks.push(own);

  return blocks.join('\n\n');
}
