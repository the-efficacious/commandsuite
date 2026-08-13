import { PATHS, PROTOCOL_HEADER, PROTOCOL_VERSION } from 'csuite-sdk/protocol';
import { describe, expect, it } from 'vitest';
import type { CreatedApp } from '../app.js';

export interface BrokerAppHarness {
  /** A fully-adapted broker application (the host's real drivers). */
  created: CreatedApp;
  /** Bearer token of a member with roster read access. */
  bearerToken: string;
  /** That member's name. */
  memberName: string;
}

/**
 * Wire-level contract for a fully-adapted broker application.
 *
 * `makeHarness` must return a FRESH app per call, built through
 * `createApp` with the host's own drivers — this is the end-to-end
 * check that an adapted stack answers the protocol the same way the
 * reference stack does. Deliberately narrow: liveness, protocol
 * gating, auth gating, and one authenticated read+write round-trip.
 * The full route surface is covered by the application's own suite;
 * this kit asserts a BINDING is wired, not that the app is correct.
 */
export function brokerAppConformance(
  makeHarness: () => BrokerAppHarness | Promise<BrokerAppHarness>,
): void {
  describe('broker application conformance', () => {
    it('answers /healthz without auth', async () => {
      const { created } = await makeHarness();
      const res = await created.app.request(PATHS.health);
      expect(res.status).toBe(200);
    });

    it('rejects a mismatched protocol version with 400', async () => {
      const { created, bearerToken } = await makeHarness();
      const res = await created.app.request(PATHS.roster, {
        headers: {
          Authorization: `Bearer ${bearerToken}`,
          [PROTOCOL_HEADER]: String(PROTOCOL_VERSION + 1),
        },
      });
      expect(res.status).toBe(400);
    });

    it('rejects an unauthenticated protected read with 401', async () => {
      const { created } = await makeHarness();
      const res = await created.app.request(PATHS.roster);
      expect(res.status).toBe(401);
    });

    it('serves the roster to a bearer-authenticated member', async () => {
      const { created, bearerToken, memberName } = await makeHarness();
      const res = await created.app.request(PATHS.roster, {
        headers: { Authorization: `Bearer ${bearerToken}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { teammates: Array<{ name: string }> };
      expect(body.teammates.map((t) => t.name)).toContain(memberName);
    });

    it('round-trips a pushed message through history', async () => {
      const { created, bearerToken } = await makeHarness();
      const push = await created.app.request(PATHS.push, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bearerToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ body: 'conformance ping' }),
      });
      expect(push.status).toBe(200);
      const history = await created.app.request(`${PATHS.history}?limit=10`, {
        headers: { Authorization: `Bearer ${bearerToken}` },
      });
      expect(history.status).toBe(200);
      const body = (await history.json()) as { messages: Array<{ body: string }> };
      expect(body.messages.some((m) => m.body === 'conformance ping')).toBe(true);
    });
  });
}
