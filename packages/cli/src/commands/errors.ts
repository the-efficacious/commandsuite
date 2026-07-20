/**
 * Shared error class for CLI subcommand argument / invocation errors.
 *
 * Subcommand handlers throw this to signal "bad user input" — the
 * top-level `main()` in `../index.ts` catches it and exits with
 * code 2 instead of the default code 1 so shell callers can tell
 * argument errors apart from runtime failures.
 */

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}
