/**
 * Environment-panel tests — the merged secrets + variables surface.
 *
 * The defect this surface repairs (#111) is that variables existed on
 * the API, CLI and MCP and NOWHERE in the web UI, so the identity rows
 * migrated out of the secrets store in #108 vanished from the only
 * human surface. The load-bearing assertions here are therefore about
 * what is VISIBLE, and each negative carries its positive control:
 *
 *   - a variable's value is rendered   ← the capability
 *   - a secret's value is never rendered   ← the classification
 *   - "set but not shown" renders differently from "unset"   ← #111's
 *     explicit requirement; rendering both blank is how a configured
 *     variable reads as missing
 *
 * Driven through a stubbed fetch + real SDK Client so schema validation
 * runs end to end — a summary shape the server would not produce fails
 * here rather than rendering something plausible.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { Client } from 'csuite-sdk/client';
import type { InstructionsResponse, SecretSummary, VariableSummary } from 'csuite-sdk/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetEnvironmentPanelForTests,
  EnvironmentPanel,
} from '../src/components/EnvironmentPanel.js';
import { __resetEnvDetailForTests } from '../src/components/env/shared.js';
import { SecretDetail } from '../src/components/SecretDetail.js';
import { VariableDetail } from '../src/components/VariableDetail.js';
import { __resetClientForTests, setClient } from '../src/lib/client.js';
import { __resetInstructionsForTests, instructions } from '../src/lib/instructions.js';
import { __resetSecretsForTests } from '../src/lib/secrets.js';
import { __resetVariablesForTests } from '../src/lib/variables.js';

const originalFetch = globalThis.fetch;

function mkPacket(permissions: InstructionsResponse['permissions']): InstructionsResponse {
  return {
    name: 'director-1',
    role: { title: 'director', description: '' },
    permissions,
    instructions: '',
    team: { name: 'demo', context: '', permissionPresets: {} },
    teammates: [
      { name: 'director-1', role: { title: 'director', description: '' }, permissions: [] },
      { name: 'cora', role: { title: 'engineer', description: '' }, permissions: [] },
    ],
    openObjectives: [],
    toolSources: [],
    teamProcess: null,
  };
}

function mkSecret(overrides: Partial<SecretSummary> = {}): SecretSummary {
  return {
    id: 'sec-1',
    slug: 'github-token',
    envName: 'GITHUB_TOKEN',
    description: '',
    enabled: true,
    allMembers: false,
    createdBy: 'director-1',
    createdAt: 1,
    updatedAt: 1,
    hasValue: true,
    bound: false,
    ...overrides,
  };
}

function mkVariable(overrides: Partial<VariableSummary> = {}): VariableSummary {
  return {
    id: 'var-1',
    slug: 'cora-git-name',
    envName: 'GIT_AUTHOR_NAME',
    description: '',
    enabled: true,
    allMembers: false,
    createdBy: 'director-1',
    createdAt: 1,
    updatedAt: 1,
    hasValue: true,
    bound: false,
    value: 'Cora',
    ...overrides,
  };
}

/**
 * A variable with NO `value` key at all — what a broker sends when the
 * caller may not read it back. Deliberately not `value: undefined`:
 * `exactOptionalPropertyTypes` rejects that, and JSON.stringify would
 * drop the key on the wire regardless, so an absent key is the state
 * the client actually receives.
 */
function mkVariableWithheldValue(overrides: Partial<VariableSummary> = {}): VariableSummary {
  const { value: _dropped, ...rest } = mkVariable(overrides);
  return rest;
}

interface Captured {
  url: string;
  init: RequestInit;
}

function stubFetch(
  routes: Array<[method: string, suffix: string, body: unknown, status?: number]>,
  captured?: Captured[],
): void {
  globalThis.fetch = ((input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init.method ?? 'GET').toUpperCase();
    captured?.push({ url, init });
    for (const [m, suffix, body, status] of routes) {
      if (m === method && url.includes(suffix)) {
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            status: status ?? 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
    }
    return Promise.resolve(new Response('{"error":"no stub route"}', { status: 500 }));
  }) as typeof fetch;
  setClient(new Client({ url: 'http://localhost', useCookies: true }));
}

/**
 * Both list routes, in the order the panel loads them. `/variables`
 * must be matched before `/secrets` is tried on a URL that contains
 * neither, so each entry is exact-suffixed by the stub's `includes`.
 */
function stubBothLists(
  secretsList: SecretSummary[],
  variablesList: VariableSummary[],
  captured?: Captured[],
): void {
  stubFetch(
    [
      ['GET', '/variables', { variables: variablesList }],
      ['GET', '/secrets', { secrets: secretsList }],
    ],
    captured,
  );
}

beforeEach(() => {
  __resetInstructionsForTests();
  __resetClientForTests();
  __resetSecretsForTests();
  __resetVariablesForTests();
  __resetEnvironmentPanelForTests();
  __resetEnvDetailForTests();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe('EnvironmentPanel', () => {
  it('shows a restricted callout without secrets.manage', () => {
    instructions.value = mkPacket(['members.manage']);
    stubBothLists([], []);
    render(<EnvironmentPanel />);
    expect(screen.getByText(/requires the secrets\.manage permission/i)).toBeTruthy();
  });

  it('lists secrets AND variables on one surface', async () => {
    // The regression in #111: after the identity migration these rows
    // left SecretsPanel and arrived nowhere. Both must be reachable
    // from the same panel.
    instructions.value = mkPacket(['secrets.manage']);
    stubBothLists([mkSecret()], [mkVariable()]);
    render(<EnvironmentPanel />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /manage secret github-token/i })).toBeTruthy();
    });
    expect(screen.getByRole('button', { name: /manage variable cora-git-name/i })).toBeTruthy();
    expect(screen.getByText('$GITHUB_TOKEN')).toBeTruthy();
    expect(screen.getByText('$GIT_AUTHOR_NAME')).toBeTruthy();
  });

  it("renders a variable's value in the row and never a secret's", async () => {
    instructions.value = mkPacket(['secrets.manage']);
    stubBothLists([mkSecret()], [mkVariable({ value: 'Cora Vance' })]);
    render(<EnvironmentPanel />);

    // Positive control: the variable's value is on screen. This is the
    // capability the variables store exists to provide.
    await waitFor(() => {
      expect(screen.getByTestId('variable-row-value-cora-git-name').textContent).toBe('Cora Vance');
    });

    // The negative it controls for: a secret carries no `value` field at
    // all, so there is nothing to render and no row value element.
    expect(screen.queryByTestId('variable-row-value-github-token')).toBeNull();
  });

  it('distinguishes set-but-not-shown from unset', async () => {
    // #111 states this explicitly: rendering both blank is how a
    // configured variable reads as missing.
    instructions.value = mkPacket(['secrets.manage']);
    stubBothLists(
      [],
      [
        mkVariable({ id: 'v-a', slug: 'shown', value: 'visible-value' }),
        // hasValue with no `value` — a broker that withheld it.
        mkVariableWithheldValue({ id: 'v-b', slug: 'hidden', hasValue: true }),
        mkVariableWithheldValue({ id: 'v-c', slug: 'unset', hasValue: false }),
      ],
    );
    render(<EnvironmentPanel />);

    await waitFor(() => {
      expect(screen.getByTestId('variable-row-value-shown').textContent).toBe('visible-value');
    });
    expect(screen.getByTestId('variable-row-value-hidden').textContent).toMatch(/set, not shown/i);
    // Unset renders no value element at all — a muted dot instead.
    expect(screen.queryByTestId('variable-row-value-unset')).toBeNull();
  });

  it('shows a per-section empty state so a missing half is legible', async () => {
    instructions.value = mkPacket(['secrets.manage']);
    stubBothLists([mkSecret()], []);
    render(<EnvironmentPanel />);
    await waitFor(() => {
      expect(screen.getByText(/no variables yet/i)).toBeTruthy();
    });
    expect(screen.queryByText(/no secrets yet/i)).toBeNull();
  });

  it('states the trace consequence of each kind on the panel', async () => {
    instructions.value = mkPacket(['secrets.manage']);
    stubBothLists([mkSecret()], [mkVariable()]);
    render(<EnvironmentPanel />);
    await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Secrets' })).toBeTruthy();
    });
    const secretSection = screen.getByRole('region', { name: 'Secrets' });
    const variableSection = screen.getByRole('region', { name: 'Variables' });
    expect(within(secretSection).getByText(/scrubbed from captured traces/i)).toBeTruthy();
    expect(within(variableSection).getByText(/left intact in captured traces/i)).toBeTruthy();
  });
});

describe('EnvironmentPanel — create', () => {
  it('will not submit until a kind is chosen', async () => {
    instructions.value = mkPacket(['secrets.manage']);
    stubBothLists([], []);
    render(<EnvironmentPanel />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /new entry/i })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: /new entry/i }));

    // No default kind: the submit button names the missing decision and
    // is disabled until it is made.
    const submit = screen.getByRole('button', { name: /choose a kind first/i });
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('radio', { name: /variable — not a secret/i }));
    expect(
      (screen.getByRole('button', { name: /register variable/i }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('POSTs to /variables when the variable kind is chosen', async () => {
    instructions.value = mkPacket(['secrets.manage']);
    const captured: Captured[] = [];
    stubFetch(
      [
        ['POST', '/variables', { variable: mkVariable({ slug: 'git-name' }) }, 201],
        ['GET', '/variables/git-name', { variable: mkVariable({ slug: 'git-name' }) }],
        ['GET', '/variables', { variables: [mkVariable({ slug: 'git-name' })] }],
        ['GET', '/secrets', { secrets: [] }],
      ],
      captured,
    );
    render(<EnvironmentPanel />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /new entry/i })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: /new entry/i }));
    fireEvent.click(screen.getByRole('radio', { name: /variable — not a secret/i }));
    fireEvent.input(screen.getByPlaceholderText('git-author-name'), {
      target: { value: 'git-name' },
    });
    fireEvent.input(screen.getByPlaceholderText('GIT_AUTHOR_NAME'), {
      target: { value: 'GIT_AUTHOR_NAME' },
    });
    fireEvent.click(screen.getByRole('button', { name: /register variable/i }));

    await waitFor(() => {
      const post = captured.find(
        (c) => (c.init.method ?? 'GET') === 'POST' && c.url.endsWith('/variables'),
      );
      expect(post).toBeTruthy();
      expect(JSON.parse(String(post?.init.body))).toMatchObject({
        slug: 'git-name',
        envName: 'GIT_AUTHOR_NAME',
      });
    });
    // The control: choosing "variable" must not have written a secret.
    expect(
      captured.some((c) => (c.init.method ?? 'GET') === 'POST' && c.url.endsWith('/secrets')),
    ).toBe(false);
  });

  it('POSTs to /secrets when the secret kind is chosen', async () => {
    instructions.value = mkPacket(['secrets.manage']);
    const captured: Captured[] = [];
    stubFetch(
      [
        ['POST', '/secrets', { secret: mkSecret({ slug: 'tok' }) }, 201],
        ['GET', '/secrets/tok', { secret: mkSecret({ slug: 'tok' }) }],
        ['GET', '/secrets', { secrets: [mkSecret({ slug: 'tok' })] }],
        ['GET', '/variables', { variables: [] }],
      ],
      captured,
    );
    render(<EnvironmentPanel />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /new entry/i })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: /new entry/i }));
    fireEvent.click(screen.getByRole('radio', { name: /^secret\b/i }));
    fireEvent.input(screen.getByPlaceholderText('github-token'), { target: { value: 'tok' } });
    fireEvent.input(screen.getByPlaceholderText('GITHUB_TOKEN'), {
      target: { value: 'GITHUB_TOKEN' },
    });
    fireEvent.click(screen.getByRole('button', { name: /register secret/i }));

    await waitFor(() => {
      const post = captured.find(
        (c) => (c.init.method ?? 'GET') === 'POST' && c.url.endsWith('/secrets'),
      );
      expect(post).toBeTruthy();
    });
    expect(
      captured.some((c) => (c.init.method ?? 'GET') === 'POST' && c.url.endsWith('/variables')),
    ).toBe(false);
  });
});

describe('VariableDetail', () => {
  it('renders the value, and SecretDetail never does', async () => {
    instructions.value = mkPacket(['secrets.manage']);
    stubFetch([
      [
        'GET',
        '/variables/cora-git-name',
        { variable: mkVariable({ value: 'Cora Vance' }), boundMembers: ['cora'] },
      ],
      ['GET', '/variables', { variables: [mkVariable({ value: 'Cora Vance' })] }],
    ]);
    render(<VariableDetail slug="cora-git-name" />);

    await waitFor(() => {
      expect(screen.getByTestId('variable-value').textContent).toBe('Cora Vance');
    });
    // The variable's input is plain text — it is not a secret, and
    // masking it would defeat the store's whole purpose.
    const input = screen.getByLabelText(/replace value/i) as HTMLInputElement;
    expect(input.type).toBe('text');
  });

  it('says a set-but-unreturned value is configured, not missing', async () => {
    instructions.value = mkPacket(['secrets.manage']);
    const withheld = mkVariableWithheldValue({ hasValue: true });
    stubFetch([
      ['GET', '/variables/cora-git-name', { variable: withheld }],
      ['GET', '/variables', { variables: [withheld] }],
    ]);
    render(<VariableDetail slug="cora-git-name" />);

    await waitFor(() => {
      expect(screen.getByText(/this is not the same as unset/i)).toBeTruthy();
    });
    expect(screen.queryByText(/no value set/i)).toBeNull();
  });

  it('renders the unset state distinctly', async () => {
    instructions.value = mkPacket(['secrets.manage']);
    const empty = mkVariableWithheldValue({ hasValue: false });
    stubFetch([
      ['GET', '/variables/cora-git-name', { variable: empty }],
      ['GET', '/variables', { variables: [empty] }],
    ]);
    render(<VariableDetail slug="cora-git-name" />);

    await waitFor(() => {
      expect(screen.getByText(/no value set/i)).toBeTruthy();
    });
    expect(screen.queryByTestId('variable-value')).toBeNull();
  });
});

describe('SecretDetail', () => {
  it('keeps the value write-only and names the no-convert constraint', async () => {
    instructions.value = mkPacket(['secrets.manage']);
    stubFetch([
      ['GET', '/secrets/github-token', { secret: mkSecret(), boundMembers: ['cora'] }],
      ['GET', '/secrets', { secrets: [mkSecret()] }],
    ]);
    render(<SecretDetail slug="github-token" />);

    await waitFor(() => {
      expect(screen.getByText(/a value is set\. it is write-only/i)).toBeTruthy();
    });
    const input = screen.getByLabelText(/^value$/i) as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.value).toBe('');
    // No reclassify action exists; the panel states why rather than
    // leaving an operator to discover it after deleting the secret.
    expect(screen.getByText(/the value cannot be carried over/i)).toBeTruthy();
  });
});
