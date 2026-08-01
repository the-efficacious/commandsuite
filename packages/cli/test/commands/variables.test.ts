/**
 * `csuite variables` command tests.
 *
 * The rule under test is the one the MCP renderer already pins one
 * plane over: **a value that is set but not visible to this caller must
 * not render like a value that is unset.** Collapsing the two is how a
 * configured variable reads as missing and gets re-created — and this
 * is the human-facing surface of the same data, so it is the place the
 * two are most likely to drift apart.
 *
 * The command takes a `Client`; a stub implementing only the methods
 * each verb touches keeps these tightly scoped, matching the MCP tool
 * tests.
 */

import type { Client } from 'csuite-sdk/client';
import type { VariableSummary } from 'csuite-sdk/types';
import { describe, expect, it, vi } from 'vitest';
import { runVariablesCommand } from '../../src/commands/variables.js';

function variable(over: Partial<VariableSummary>): VariableSummary {
  return {
    id: '1',
    slug: 'a-var',
    envName: 'A_VAR',
    description: '',
    enabled: true,
    allMembers: false,
    createdBy: 'admin',
    createdAt: 0,
    updatedAt: 0,
    hasValue: false,
    bound: false,
    ...over,
  };
}

function capture() {
  const lines: string[] = [];
  return { lines, out: (l: string) => lines.push(l) };
}

describe('csuite variables', () => {
  it('prints the value, which is the capability secrets do not have', async () => {
    const { lines, out } = capture();
    const client = {
      listVariables: vi.fn(async () => [
        variable({
          slug: 'cora-git-author-name',
          envName: 'GIT_AUTHOR_NAME',
          hasValue: true,
          value: 'Cora',
        }),
      ]),
    } as unknown as Client;

    await runVariablesCommand(['list'], client, out);

    expect(lines.join('\n')).toContain('Cora');
    expect(lines.join('\n')).toContain('GIT_AUTHOR_NAME');
  });

  it('distinguishes set-but-not-visible from unset, in list and in view', async () => {
    const { lines, out } = capture();
    const client = {
      listVariables: vi.fn(async () => [
        variable({ slug: 'hidden', hasValue: true }), // set, value withheld
        variable({ slug: 'empty', hasValue: false }), // genuinely unset
      ]),
    } as unknown as Client;

    await runVariablesCommand(['list'], client, out);
    const listed = lines.join('\n');
    expect(listed).toContain('(value hidden)');
    expect(listed).toContain('(no value)');

    const view = capture();
    const one = {
      getVariable: vi.fn(async () => ({ variable: variable({ slug: 'hidden', hasValue: true }) })),
    } as unknown as Client;
    await runVariablesCommand(['view', 'hidden'], one, view.out);
    expect(view.lines.join('\n')).toContain('(hidden)');

    const unset = capture();
    const two = {
      getVariable: vi.fn(async () => ({ variable: variable({ slug: 'empty', hasValue: false }) })),
    } as unknown as Client;
    await runVariablesCommand(['view', 'empty'], two, unset.out);
    expect(unset.lines.join('\n')).toContain('(unset)');
  });

  it('states that the value is not redacted, on the surface where someone would paste a token', async () => {
    const { lines, out } = capture();
    const client = {
      getVariable: vi.fn(async () => ({
        variable: variable({ hasValue: true, value: 'eu-west-1' }),
      })),
    } as unknown as Client;

    await runVariablesCommand(['view', 'a-var'], client, out);

    expect(lines.join('\n')).toContain('never registered');
  });
});
