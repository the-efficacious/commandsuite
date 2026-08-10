/**
 * `csuite quickstart` — zero-to-first-contract helper.
 *
 * Assumes the caller has already run `csuite setup` (or ingested a
 * team config some other way). Picks up from "you have a token and
 * a broker URL" and seeds the remaining first-session experience:
 *
 *   1. Health-check the broker at the configured URL. If it's not up,
 *      print a clear "start `csuite serve` first" message and exit 1.
 *   2. Resolve an assignee for the demo contract. Defaults to the
 *      first teammate on the roster without `spine.author` permission
 *      (the execution-flavored role the demo suits); falls back to the
 *      first teammate if everyone can author.
 *   3. Register the demo's SUBJECT and author the demo contract
 *      ("summarize this repository in 3 paragraphs") with the caller
 *      as author and the chosen member as assignee. Idempotent: skips
 *      both if a contract with the same title is already open.
 *   4. Best-effort open the web UI in the user's default browser.
 *      Cross-platform (macOS `open`, Linux `xdg-open`, Windows `start`).
 *      Never fails the command if the open fails — the URL is always
 *      printed alongside so the user can click/paste themselves.
 *   5. Print a crisp "next step" block pointing at `csuite claude`.
 *
 * WHY IT REGISTERS A SUBJECT. The spine has no unbound work: a contract
 * is about a piece of the world, and a subject is REGISTERED rather
 * than guessed. The demo needs one, so quickstart registers exactly one
 * — `doc:quickstart` — as a deliberate act of the operator who ran the
 * command. It does not parse a repo name out of the working directory,
 * which would be the same guess wearing a plausible costume.
 *
 * The demo names NO VERIFIER, deliberately. A verifier is a member who
 * judges each criterion at a revision, and quickstart has no business
 * volunteering someone for that. A contract with no verifier completes
 * on its result alone and says so, which is the honest shape for a
 * demo.
 *
 * This intentionally does NOT spawn a broker in-process (that would
 * leave a long-lived process hanging off an interactive quickstart
 * invocation, which is a confusing ownership model) and does NOT run
 * the setup wizard automatically (the wizard prints credentials once
 * and an accidental re-run from quickstart would invalidate them).
 * Both of those flows stay as explicit user actions.
 */

import { spawn } from 'node:child_process';
import type { Client, ClientError } from 'csuite-sdk/client';

const DEMO_SUBJECT = 'doc:quickstart';
const DEMO_TITLE = 'quickstart — summarize this repository';
const DEMO_CRITERION =
  'A 3-paragraph summary of the current working directory is posted to ' +
  "this contract's thread: (1) what kind of project this is, (2) the " +
  "most important entry points or subdirectories, (3) one thing that's " +
  'surprising or unusual. Read files; do not run the code.';

export interface QuickstartCommandInput {
  url: string;
  token: string;
  /** Skip the browser-open step (tests, headless CI). */
  skipBrowser?: boolean;
  /** Override the demo contract's assignee name. */
  assignee?: string;
}

export interface QuickstartReport {
  /** The web UI URL the member should visit. */
  webUrl: string;
  /** The demo contract id (whether newly authored or already present). */
  contractId: string;
  /** True if this invocation authored the demo contract; false if reused. */
  created: boolean;
  /** The name the demo was assigned to. */
  assignee: string;
  /** Whether we attempted to open the browser, and the outcome. */
  browserOpen: 'opened' | 'skipped' | 'failed' | 'unsupported';
}

export async function runQuickstartCommand(
  input: QuickstartCommandInput,
  client: Client,
  log: (line: string) => void,
): Promise<QuickstartReport> {
  // 1. Health check — the most common failure mode is the broker
  //    simply isn't running. Surface that with a clear hint before
  //    attempting anything else.
  try {
    await client.health();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new QuickstartError(
      `broker unreachable at ${input.url}: ${msg}\n` +
        `  hint: is \`csuite serve\` running at ${input.url}?\n` +
        `        (if you have not finished setup yet, run \`csuite setup\` first)`,
    );
  }

  // 2. Resolve an assignee. Prefer a teammate without `spine.author`
  //    permission because the demo is execution-flavored work (do a
  //    task); fall back to the first teammate if everyone on the
  //    roster can author.
  const rosterResp = await client.roster();
  if (rosterResp.teammates.length === 0) {
    throw new QuickstartError(
      'team has no users configured — run `csuite setup` to create one before quickstart.',
    );
  }
  const assignee =
    input.assignee ??
    rosterResp.teammates.find((t) => !t.permissions.includes('spine.author'))?.name ??
    rosterResp.teammates[0]?.name;
  if (!assignee) {
    // Unreachable given the length check above, but keeps the types honest.
    throw new QuickstartError('no name resolvable from roster response');
  }

  // 3. Check whether the demo is already seeded. We identify it by
  //    exact title match — the quickstart title string is distinctive
  //    enough to make false positives vanishingly unlikely, and this
  //    keeps the command idempotent so re-running it doesn't spray
  //    demo contracts across the board.
  let contractId: string | null = null;
  let created = false;
  try {
    const existing = await client.spineContracts({});
    const match = existing.find((c) => c.title === DEMO_TITLE);
    if (match) contractId = match.id;
  } catch (err) {
    // Non-fatal — we can always try to author; if that fails the
    // caller sees the real error.
    log(
      `quickstart: could not list existing contracts (continuing): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (contractId === null) {
    try {
      // The subject first: a contract is about a piece of the world,
      // and the spine has no way to name one that was never
      // registered. Registration is idempotent on a matching row, so a
      // re-run after a failed authoring does not fail here.
      await client.registerSpineSubject({ id: DEMO_SUBJECT, type: 'doc' });
      const result = await client.appendSpineEvent({
        kind: 'specification',
        subject: DEMO_SUBJECT,
        // Derived from the title, so a retry after a lost response
        // resolves to the event that already landed rather than
        // authoring a second contract.
        opId: `quickstart:${DEMO_TITLE}`,
        body: {
          title: DEMO_TITLE,
          criteria: [{ id: 'summary', text: DEMO_CRITERION }],
          assignee,
        },
      });
      contractId = result.event.id;
      created = true;
    } catch (err) {
      const ce = err as ClientError;
      throw new QuickstartError(
        `failed to author the demo contract: ${ce.message ?? String(err)}\n` +
          `  (authoring requires the \`spine.author\` permission; ` +
          `check your permissions with \`csuite roster\`)`,
      );
    }
  }

  // 4. Best-effort open the browser. Print the URL unconditionally so
  //    the user can click it themselves if the open fails.
  const webUrl = input.url.replace(/\/+$/, '');
  let browserOpen: QuickstartReport['browserOpen'] = 'skipped';
  if (!input.skipBrowser) {
    browserOpen = tryOpenBrowser(webUrl);
  }

  // 5. Pretty status to stdout — the user sees this directly.
  log('');
  log('csuite quickstart — ready.');
  log('');
  log(
    `  team  ${rosterResp.teammates[0]?.name ?? '?'} (and ${rosterResp.teammates.length - 1} more)`,
  );
  log(`  broker    ${input.url} (ONLINE)`);
  log(`  assignee  ${assignee}`);
  log(`  demo      ${contractId} ${created ? '(authored)' : '(already seeded; reusing)'}`);
  log('');
  log(`  web UI    ${webUrl}`);
  switch (browserOpen) {
    case 'opened':
      log('            (opened in your default browser)');
      break;
    case 'failed':
      log('            (tried to open it — command returned an error. visit the URL above.)');
      break;
    case 'unsupported':
      log('            (no default-browser open command for this platform; visit the URL above.)');
      break;
    case 'skipped':
      break;
  }
  log('');
  log('  NEXT:     in a separate terminal, run `csuite claude` to execute the demo');
  log('            (or watch the web UI as you re-run this command to re-seed)');
  log('');

  return { webUrl, contractId, created, assignee, browserOpen };
}

/**
 * Attempt to open `url` in the OS default browser. Returns a flag
 * describing what happened — never throws. We never want a failed
 * browser open to fail the quickstart, because the user can always
 * click the URL we already printed.
 */
function tryOpenBrowser(url: string): QuickstartReport['browserOpen'] {
  const { command, args } = openCommandFor(process.platform, url);
  if (command === null) return 'unsupported';

  try {
    // Detached + unref so the quickstart doesn't end up waiting on the
    // browser process. We don't need stdio from the browser either.
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.unref();
    child.on('error', () => {
      /* we report via the returned flag — failures from here are logged nowhere */
    });
    return 'opened';
  } catch {
    return 'failed';
  }
}

function openCommandFor(
  platform: NodeJS.Platform,
  url: string,
): { command: string | null; args: string[] } {
  switch (platform) {
    case 'darwin':
      return { command: 'open', args: [url] };
    case 'win32':
      // `start` is a cmd.exe builtin, not a program — wrap through cmd.
      return { command: 'cmd', args: ['/c', 'start', '""', url] };
    case 'linux':
    case 'freebsd':
    case 'openbsd':
      return { command: 'xdg-open', args: [url] };
    default:
      return { command: null, args: [] };
  }
}

export class QuickstartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuickstartError';
  }
}
