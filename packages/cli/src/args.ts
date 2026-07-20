/**
 * Shared argument parser for `csuite` subcommands.
 *
 * Uses `node:util` parseArgs to keep the CLI zero-dep. Subcommand
 * dispatch is a plain switch on the first positional argument.
 */

import { type ParseArgsConfig, parseArgs } from 'node:util';

export type ParsedValues = Record<string, string | boolean | Array<string | boolean> | undefined>;

export function parseSubcommandArgs(
  argv: string[],
  options: ParseArgsConfig['options'],
): {
  values: ParsedValues;
  positionals: string[];
} {
  try {
    const result = parseArgs({
      args: argv,
      options,
      allowPositionals: true,
      strict: true,
    });
    return {
      values: result.values as ParsedValues,
      positionals: result.positionals,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`argument error: ${msg}`);
  }
}

export function parseDataFlag(
  raw: string | string[] | undefined,
): Record<string, string> | undefined {
  if (!raw) return undefined;
  const entries = Array.isArray(raw) ? raw : [raw];
  const out: Record<string, string> = {};
  for (const entry of entries) {
    const idx = entry.indexOf('=');
    if (idx === -1) {
      throw new Error(`--data: expected key=value, got '${entry}'`);
    }
    const key = entry.slice(0, idx);
    const value = entry.slice(idx + 1);
    out[key] = value;
  }
  return out;
}
