import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateBearerToken } from 'csuite-core';
import type { Client } from 'csuite-sdk/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runRotateCommand } from '../../src/commands/rotate.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function target(): string {
  const dir = mkdtempSync(join(tmpdir(), 'csuite-rotate-'));
  dirs.push(dir);
  return join(dir, 'runner.token');
}

describe('rotate credential output', () => {
  it('rotates one token into an O_EXCL 0600 file without printing plaintext', async () => {
    const raw = generateBearerToken();
    const rotateToken = vi.fn().mockResolvedValue({
      token: raw,
      tokenInfo: { id: '11111111-1111-4111-8111-111111111111' },
    });
    const path = target();
    const lines: string[] = [];

    await runRotateCommand(
      {
        member: 'builder',
        tokenId: '22222222-2222-4222-8222-222222222222',
        tokenFile: path,
      },
      { rotateToken } as unknown as Client,
      (line) => lines.push(line),
    );

    expect(rotateToken).toHaveBeenCalledWith('builder', {
      scope: 'token',
      tokenId: '22222222-2222-4222-8222-222222222222',
    });
    expect(readFileSync(path, 'utf8')).toBe(`${raw}\n`);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(lines.join('\n')).not.toContain(raw);
    expect(lines.join('\n')).toContain('new token id: 11111111-1111-4111-8111-111111111111');
  });

  it('requires an explicit scope and a token file', async () => {
    const client = { rotateToken: vi.fn() } as unknown as Client;
    await expect(runRotateCommand({ member: 'builder' }, client, vi.fn())).rejects.toThrow(
      /choose exactly one/,
    );
    await expect(
      runRotateCommand({ member: 'builder', all: true }, client, vi.fn()),
    ).rejects.toThrow(/--token-file/);
  });

  it('refuses to overwrite an existing credential file before calling the broker', async () => {
    const path = target();
    writeFileSync(path, 'mine\n', { mode: 0o600 });
    const rotateToken = vi.fn();
    await expect(
      runRotateCommand(
        { member: 'builder', all: true, tokenFile: path },
        { rotateToken } as unknown as Client,
        vi.fn(),
      ),
    ).rejects.toThrow(/already exists/);
    expect(rotateToken).not.toHaveBeenCalled();
    expect(readFileSync(path, 'utf8')).toBe('mine\n');
  });
});
