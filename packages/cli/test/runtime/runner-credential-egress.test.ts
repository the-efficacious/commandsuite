import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { generateBearerToken } from 'csuite-core';
import { describe, expect, it } from 'vitest';
import { guardCredentialFreeToolResult } from '../../src/runtime/runner.js';

function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

describe('runner credential egress guard', () => {
  it.each(['members_add', 'rotate', 'connect approve'])(
    'keeps a %s-shaped result out of IPC and agent context',
    (surface) => {
      const token = generateBearerToken();
      const guarded = guardCredentialFreeToolResult(
        textResult(JSON.stringify({ surface, nested: JSON.stringify({ token }) })),
      );
      const serialized = JSON.stringify(guarded);
      expect(guarded.isError).toBe(true);
      expect(serialized).toContain('credential-shaped content');
      expect(serialized).not.toContain(token);
    },
  );

  it('returns an ordinary credential-free result unchanged', () => {
    const result = textResult('member created pending device enrolment');
    expect(guardCredentialFreeToolResult(result)).toBe(result);
  });
});
