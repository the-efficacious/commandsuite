/**
 * The two carriers that decide the CLI's exit code.
 *
 * Exit codes are the CLI's machine contract with a shell caller or a
 * supervisor, and the only split that contract has ever promised is
 * "will this succeed if you run it again?":
 *
 *   - `UsageError` → exit **2**. The argv is wrong: a bad flag, a
 *     missing positional, two mutually exclusive options. Retrying is
 *     pointless — a typo does not fix itself — so a supervisor may
 *     legitimately stop on 2.
 *   - `StartupError` → exit **1**. The argv was fine and the
 *     environment was not: the broker is unreachable, the agent binary
 *     is missing, nothing is enrolled for this (url, cwd). Every one of
 *     these can be true now and false in thirty seconds, so a
 *     supervisor must keep restarting.
 *
 * Both are thrown by subcommand handlers and caught by `failFrom()` in
 * `../index.ts`, which is the single place either becomes a number.
 * Routing a runtime failure through `UsageError` — which is what
 * `runAgentSession` did until #253 — tells `Restart=always` that a
 * broker outage is an operator typo.
 */

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/**
 * A startup or environment failure: the invocation was well-formed and
 * the machine it landed on could not carry it out. Carries the same
 * one-line operator-readable message as `UsageError` and differs only
 * in the code it exits with, so the same condition reported from a
 * runner verb, from `install-service` and from `cycle` cannot drift
 * apart again.
 */
export class StartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StartupError';
  }
}
