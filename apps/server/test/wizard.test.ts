/**
 * First-run wizard tests.
 *
 * The wizard collects a team + first admin member, auto-enrolls the
 * admin in TOTP, and returns the captured `WizardResult` for the
 * caller to seed into the database. Tests stub stdin with a scripted
 * queue so each test drives the exact sequence of prompts the wizard
 * asks, and pin the TOTP secret + clock so verification is
 * deterministic.
 *
 * The wizard NO LONGER touches disk — no file is written, no config
 * is loaded back. Persistence is the caller's responsibility (CLI
 * setup, server boot path). These tests therefore assert on the
 * returned data shape and the conversation flow, not on file IO.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { MemberLoadError } from '../src/members.js';
import { currentCode } from '../src/totp.js';
import { type RunWizardOptions, runFirstRunWizard, type WizardIO } from '../src/wizard.js';

interface MockIO extends WizardIO {
  output: string[];
  remaining(): number;
}

function mockIO(scripted: string[], isInteractive = true): MockIO {
  const queue = scripted.slice();
  const output: string[] = [];
  return {
    output,
    isInteractive,
    prompt: async (question) => {
      output.push(`? ${question}`);
      const next = queue.shift();
      if (next === undefined) {
        throw new Error(`mock IO exhausted (prompt: ${question})`);
      }
      return next;
    },
    println: (line) => {
      output.push(line);
    },
    redactLines: () => {},
    remaining: () => queue.length,
  };
}

const FIXED_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const FIXED_NOW_MS = 1_700_000_000_000;
// configPath is informational only — the wizard doesn't write to it.
const FAKE_CONFIG_PATH = '/tmp/csuite-wizard-test/csuite.json';

describe('runFirstRunWizard', () => {
  afterEach(() => {
    /* nothing to clean — wizard is now I/O-only and writes no files */
  });

  function wizardOpts(io: WizardIO): RunWizardOptions {
    return {
      configPath: FAKE_CONFIG_PATH,
      io,
      tokenFactory: () => 'csuite_test_fixed_token',
      totpSecretFactory: () => FIXED_TOTP_SECRET,
      now: () => FIXED_NOW_MS,
      qrRenderer: () => '«qr»',
    };
  }

  // Happy-path script: team name (default), directive, context (skip),
  // admin name (default), role title (default), role description (skip),
  // press enter after token banner, TOTP code.
  function happyScript(code: string, overrides: Partial<Record<string, string>> = {}): string[] {
    return [
      overrides.teamName ?? '',
      overrides.directive ?? 'Ship the payment service',
      overrides.context ?? '',
      overrides.adminName ?? '',
      overrides.roleTitle ?? '',
      overrides.roleDescription ?? '',
      '',
      code,
    ];
  }

  it('captures team + first admin and returns a seedable WizardResult', async () => {
    const code = currentCode(FIXED_TOTP_SECRET, FIXED_NOW_MS);
    const io = mockIO(happyScript(code));

    const result = await runFirstRunWizard(wizardOpts(io));

    expect(result.team.name).toBe('my-team');
    expect(result.team.directive).toBe('Ship the payment service');
    expect(result.team.context).toBe('');
    expect(result.team.permissionPresets).toBeDefined();

    expect(result.admin.name).toBe('director-1');
    expect(result.admin.role.title).toBe('director');
    expect(result.admin.permissions).toContain('members.manage');
    expect(result.admin.rawPermissions).toEqual(['admin']);
    expect(result.admin.token).toBe('csuite_test_fixed_token');
    expect(result.admin.totpSecret).toBe(FIXED_TOTP_SECRET);

    expect(io.remaining()).toBe(0);
  });

  it('ships admin + operator permission presets in the captured team', async () => {
    const code = currentCode(FIXED_TOTP_SECRET, FIXED_NOW_MS);
    const io = mockIO(happyScript(code));
    const result = await runFirstRunWizard(wizardOpts(io));

    expect(result.team.permissionPresets.admin).toBeDefined();
    expect(result.team.permissionPresets.admin).toContain('members.manage');
    expect(result.team.permissionPresets.operator).toContain('objectives.create');
  });

  it('accepts a custom admin role title and description', async () => {
    const code = currentCode(FIXED_TOTP_SECRET, FIXED_NOW_MS);
    const io = mockIO(happyScript(code, { roleTitle: 'chief', roleDescription: 'Runs the ship' }));
    const result = await runFirstRunWizard(wizardOpts(io));

    expect(result.admin.role.title).toBe('chief');
    expect(result.admin.role.description).toBe('Runs the ship');
  });

  it('re-prompts on an invalid admin name and keeps going', async () => {
    const code = currentCode(FIXED_TOTP_SECRET, FIXED_NOW_MS);
    const io = mockIO([
      '', // team name
      'Ship', // directive
      '', // context
      'has spaces', // bad name, rejected
      'chief', // good name
      '', // role title (default)
      '', // role description (skip)
      '',
      code,
    ]);
    const result = await runFirstRunWizard(wizardOpts(io));
    expect(result.admin.name).toBe('chief');
    expect(io.output.some((l) => l.includes('alphanumeric with . _ -'))).toBe(true);
  });

  it('re-prompts on a bad TOTP code and succeeds on retry', async () => {
    const code = currentCode(FIXED_TOTP_SECRET, FIXED_NOW_MS);
    const io = mockIO([...happyScript('000000'), code]);
    const result = await runFirstRunWizard(wizardOpts(io));
    expect(result.admin.totpSecret).toBe(FIXED_TOTP_SECRET);
    expect(io.output.some((l) => l.includes('try again'))).toBe(true);
  });

  it('aborts with MemberLoadError after repeated bad TOTP codes', async () => {
    const io = mockIO([...happyScript('000000'), '111111', '222222']);
    await expect(runFirstRunWizard(wizardOpts(io))).rejects.toBeInstanceOf(MemberLoadError);
  });

  it('throws MemberLoadError when the IO is non-interactive', async () => {
    const io = mockIO([], false);
    await expect(runFirstRunWizard(wizardOpts(io))).rejects.toMatchObject({
      name: 'MemberLoadError',
      message: expect.stringContaining('not a TTY'),
    });
  });
});
