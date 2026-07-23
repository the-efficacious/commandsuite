/**
 * `csuite quickstart` — zero-to-first-objective helper.
 *
 * Assumes the caller has already run `csuite setup` (or ingested a
 * team config some other way). Picks up from "you have a token and
 * a broker URL" and seeds the remaining first-session experience:
 *
 *   1. Health-check the broker at the configured URL. If it's not up,
 *      print a clear "start `csuite serve` first" message and exit 1.
 *   2. Resolve an assignee for a demo objective. Defaults to the first
 *      teammate on the roster without `objectives.create` permission
 *      (the execution-flavored role a demo objective suits); falls
 *      back to the first teammate if everyone can create objectives.
 *   3. Create the demo objective ("summarize this repository in 3
 *      paragraphs") with the caller as originator and the chosen user
 *      as assignee. Idempotent-ish: skips creation if a demo objective
 *      with the same title is already on the roster.
 *   4. Best-effort open the web UI in the user's default browser.
 *      Cross-platform (macOS `open`, Linux `xdg-open`, Windows `start`).
 *      Never fails the command if the open fails — the URL is always
 *      printed alongside so the user can click/paste themselves.
 *   5. Print a crisp "next step" block pointing at `csuite claude-code`.
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

const DEMO_TITLE = 'quickstart — summarize this repository';
const DEMO_OUTCOME =
  'Post a 3-paragraph summary of the current working directory to this ' +
  "objective's thread: (1) what kind of project this is, (2) the " +
  "most important entry points or subdirectories, (3) one thing that's " +
  'surprising or unusual. Read files; do not run the code.';
const DEMO_BODY =
  'This is the demo objective seeded by `csuite quickstart`. It exists to ' +
  'give you something to execute on turn 1 so you can see the whole ' +
  'flow end-to-end: trace capture, objective tracking, web UI rendering. ' +
  'You can cancel or reassign it at any time; it is not load-bearing.';

export interface QuickstartCommandInput {
  url: string;
  token: string;
  /** Skip the browser-open step (tests, headless CI). */
  skipBrowser?: boolean;
  /** Override the demo objective's assignee name. */
  assignee?: string;
}

export interface QuickstartReport {
  /** The web UI URL the member should visit. */
  webUrl: string;
  /** The demo objective id (whether newly created or already present). */
  objectiveId: string;
  /** True if this invocation created the demo objective; false if reused. */
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

  // 2. Resolve an assignee. Prefer a teammate without `objectives.create`
  //    permission because the demo objective is execution-flavored work
  //    (do a task); fall back to the first teammate if everyone on the
  //    roster can create objectives.
  const rosterResp = await client.roster();
  if (rosterResp.teammates.length === 0) {
    throw new QuickstartError(
      'team has no users configured — run `csuite setup` to create one before quickstart.',
    );
  }
  const assignee =
    input.assignee ??
    rosterResp.teammates.find((t) => !t.permissions.includes('objectives.create'))?.name ??
    rosterResp.teammates[0]?.name;
  if (!assignee) {
    // Unreachable given the length check above, but keeps the types honest.
    throw new QuickstartError('no name resolvable from roster response');
  }

  // 3. Check whether the demo is already seeded. We identify it by
  //    exact title match — the quickstart title string is distinctive
  //    enough to make false positives vanishingly unlikely, and this
  //    keeps the command idempotent so re-running it doesn't spray
  //    demo objectives across the thread list.
  let objectiveId: string | null = null;
  let created = false;
  try {
    const existing = await client.listObjectives({ status: 'active' });
    const match = existing.find((o) => o.title === DEMO_TITLE);
    if (match) objectiveId = match.id;
  } catch (err) {
    // Non-fatal — we can always try to create; if creation fails with
    // a duplicate-title error the caller sees that error.
    log(
      `quickstart: could not list existing objectives (continuing): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (objectiveId === null) {
    try {
      const obj = await client.createObjective({
        title: DEMO_TITLE,
        outcome: DEMO_OUTCOME,
        body: DEMO_BODY,
        assignee,
      });
      objectiveId = obj.id;
      created = true;
    } catch (err) {
      const ce = err as ClientError;
      throw new QuickstartError(
        `failed to create demo objective: ${ce.message ?? String(err)}\n` +
          `  (creating objectives requires the \`objectives.create\` permission; ` +
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
  log(`  demo      ${objectiveId} ${created ? '(created)' : '(already seeded; reusing)'}`);
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
  log('  NEXT:     in a separate terminal, run `csuite claude-code` to execute the demo');
  log('            (or watch the web UI as you re-run this command to re-seed)');
  log('');

  return { webUrl, objectiveId, created, assignee, browserOpen };
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
