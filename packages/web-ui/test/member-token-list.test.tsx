/**
 * MemberTokenList — the origin vocabulary, on both surfaces that show it.
 *
 * `TokenOrigin` is a wire enum (`bootstrap` / `rotate` / `enroll`) and
 * the list translates it for a reader (`config-file` / `rotated` /
 * `device-code`). The revoke dialog used to interpolate the raw wire
 * value instead, so the badge on the row and the sentence in the
 * dialog that revokes that row named the same token two different
 * ways — the reader's one chance to check they are about to kill the
 * right credential.
 *
 * So the badge assertion is an exact array over the WHOLE enum (a
 * mapping that covers two of three origins fails), and the dialog
 * assertion compares against the RENDERED badge text of that same
 * row rather than a literal, for every row — a fix applied to one
 * branch of the switch fails. It deliberately avoids
 * `not.toContain('rotate')`, which the buggy `rotate` / `rotated`
 * substring relationship would satisfy while still being wrong.
 */

import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import type { Client } from 'csuite-sdk/client';
import type { TokenInfo } from 'csuite-sdk/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetMemberTokenListForTests,
  MemberTokenList,
} from '../src/components/members/MemberTokenList.js';
import { __resetClientForTests, setClient } from '../src/lib/client.js';
import { __resetConfirmForTests, pendingConfirm } from '../src/lib/confirm.js';

/**
 * One row per `TokenOrigin`, in enum order. The labels carry no
 * ' · ' so splitting the dialog body on that separator is
 * unambiguous.
 */
const TOKENS: TokenInfo[] = [
  {
    id: 'tok_bootstrap',
    memberName: 'engineer-1',
    label: 'seed-key',
    origin: 'bootstrap',
    createdAt: 1_700_000_000_000,
    lastUsedAt: null,
    expiresAt: null,
    createdBy: null,
  },
  {
    id: 'tok_rotate',
    memberName: 'engineer-1',
    label: 'ci-runner',
    origin: 'rotate',
    createdAt: 1_700_000_100_000,
    lastUsedAt: 1_700_000_200_000,
    expiresAt: null,
    createdBy: 'director-1',
  },
  {
    id: 'tok_enroll',
    memberName: 'engineer-1',
    label: 'laptop',
    origin: 'enroll',
    createdAt: 1_700_000_300_000,
    lastUsedAt: null,
    expiresAt: 1_800_000_000_000,
    createdBy: 'engineer-1',
  },
];

function stubClient(): void {
  setClient({
    listTokens: async () => TOKENS,
    revokeToken: async () => undefined,
  } as unknown as Client);
}

/**
 * The origin badge of each rendered row, in row order. Selected
 * structurally (the second `<span>` of a row is the badge) so the
 * test does not presume the text it is about to assert.
 */
function originBadges(container: ParentNode): HTMLElement[] {
  return Array.from(container.querySelectorAll('li')).map((li) => {
    const badge = li.querySelectorAll('span')[1];
    if (!badge) throw new Error('row rendered without an origin badge');
    return badge;
  });
}

beforeEach(() => {
  __resetMemberTokenListForTests();
  __resetClientForTests();
  __resetConfirmForTests();
  stubClient();
});

afterEach(() => {
  cleanup();
  __resetConfirmForTests();
  __resetClientForTests();
  __resetMemberTokenListForTests();
});

describe('MemberTokenList origins', () => {
  it('labels every origin with the display vocabulary', async () => {
    const { container } = render(<MemberTokenList memberName="engineer-1" />);
    await waitFor(() => expect(container.querySelectorAll('li').length).toBe(TOKENS.length));

    // The whole enum, in row order: a mapping that translates two of
    // the three origins and passes the third through raw fails here.
    expect(originBadges(container).map((el) => el.textContent)).toEqual([
      'config-file',
      'rotated',
      'device-code',
    ]);
  });

  it('the revoke dialog names the origin the same way the row does', async () => {
    const { container } = render(<MemberTokenList memberName="engineer-1" />);
    await waitFor(() => expect(container.querySelectorAll('li').length).toBe(TOKENS.length));

    const rows = Array.from(container.querySelectorAll('li'));
    const badges = originBadges(container);

    for (const [i, li] of rows.entries()) {
      const revoke = li.querySelector('button');
      if (!revoke) throw new Error(`row ${i} rendered without a revoke button`);
      fireEvent.click(revoke);

      // `ConfirmRequest.body` is optional, so narrow before splitting.
      const body = pendingConfirm.value?.body;
      expect(body).toBeDefined();
      if (!body) throw new Error('no body');

      // Compared against the badge this very row rendered, not a
      // literal: the defect is precisely that the two surfaces
      // disagree about the same token.
      expect(body.split(' · ')[1]).toBe(badges[i]?.textContent);

      __resetConfirmForTests();
    }
  });
});
