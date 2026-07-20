/**
 * AccountPanel — self-service settings at `/account`.
 *
 *   ┌─────────────────────────────────────────────┐
 *   │ Account                                     │
 *   │ Settings for @alice                          │
 *   ├─────────────────────────────────────────────┤
 *   │ Security                                    │
 *   │   Bearer token        [Rotate]              │
 *   │   TOTP                [Re-enroll]           │
 *   ├─────────────────────────────────────────────┤
 *   │ Notifications                                │
 *   │   Push on this device [toggle]              │
 *   ├─────────────────────────────────────────────┤
 *   │ Profile                                      │
 *   │   → View public profile                      │
 *   └─────────────────────────────────────────────┘
 *
 * Uses the same self-service paths the server already permits:
 *   - POST /members/:self/rotate-token
 *   - POST /members/:self/enroll-totp
 * Both emit one-time secrets that land in the Reveal banner.
 *
 * This panel is distinct from the Manage tab on a member's profile:
 *   - Profile = public identity (viewable by everyone on the team)
 *   - Account = private settings (only you, only for yourself)
 */

import { signal } from '@preact/signals';
import { getClient } from '../lib/client.js';
import { selectMemberProfile } from '../lib/view.js';
import { AppearancePanel } from './AppearancePanel.js';
import { type Reveal, RevealBanner } from './members/Reveal.js';
import { NotificationToggle } from './NotificationToggle.js';
import { PageHeader } from './ui/index.js';

export interface AccountPanelProps {
  viewer: string;
}

const busy = signal<'rotate' | 'totp' | null>(null);
const accountReveal = signal<Reveal | null>(null);

export function AccountPanel({ viewer }: AccountPanelProps) {
  const b = busy.value;
  const revealed = accountReveal.value;

  async function onRotate(): Promise<void> {
    if (
      !confirm(
        'Rotate your bearer token?\n\nThe existing token will be invalidated immediately — any CLI or integration using it will stop working until updated.',
      )
    )
      return;
    busy.value = 'rotate';
    try {
      const response = await getClient().rotateToken(viewer);
      accountReveal.value = { kind: 'rotate', name: viewer, response };
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      busy.value = null;
    }
  }

  async function onEnrollTotp(): Promise<void> {
    if (
      !confirm(
        'Re-enroll TOTP for your account?\n\nAny authenticator app currently bound will stop working. Scan the new secret with your authenticator app before dismissing the banner.',
      )
    )
      return;
    busy.value = 'totp';
    try {
      const response = await getClient().enrollTotp(viewer);
      accountReveal.value = { kind: 'totp', name: viewer, response };
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      busy.value = null;
    }
  }

  return (
    <div
      class="flex-1 overflow-y-auto"
      style="padding:24px max(1rem,env(safe-area-inset-right)) 32px max(1rem,env(safe-area-inset-left))"
    >
      <PageHeader eyebrow="Account" title="Settings" subtitle={`Signed in as @${viewer}`} />

      {revealed && (
        <RevealBanner
          reveal={revealed}
          onDismiss={() => {
            accountReveal.value = null;
          }}
        />
      )}

      <section class="card" style="padding:16px;margin-bottom:14px">
        <div class="eyebrow" style="margin-bottom:12px">
          Security
        </div>
        <div style="display:flex;flex-direction:column;gap:14px">
          <Row
            title="Bearer token"
            description="Used by CLI sessions and API integrations. Rotating invalidates the existing token immediately."
            action={
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                onClick={() => void onRotate()}
                disabled={b !== null}
              >
                {b === 'rotate' ? 'Rotating…' : 'Rotate token'}
              </button>
            }
          />
          <Row
            title="Authenticator (TOTP)"
            description="6-digit code for web UI sign-in. Re-enrolling invalidates the secret bound to your current authenticator app."
            action={
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                onClick={() => void onEnrollTotp()}
                disabled={b !== null}
              >
                {b === 'totp' ? 'Enrolling…' : 'Re-enroll TOTP'}
              </button>
            }
          />
        </div>
      </section>

      <section class="card" style="padding:16px;margin-bottom:14px">
        <div class="eyebrow" style="margin-bottom:12px">
          Notifications
        </div>
        <Row
          title="Push on this device"
          description="Toggle browser push notifications for this device. You can enable or disable independently per browser."
          action={<NotificationToggle />}
        />
      </section>

      <section class="card" style="padding:16px;margin-bottom:14px">
        <div class="eyebrow" style="margin-bottom:12px">
          Appearance
        </div>
        <Row
          title="Theme"
          description="Light, dark, or follow your system preference. Saved per browser."
          action={<AppearancePanel />}
        />
      </section>

      <section class="card" style="padding:16px">
        <div class="eyebrow" style="margin-bottom:12px">
          Profile
        </div>
        <Row
          title="Public profile"
          description="How you appear to teammates — name, role, activity."
          action={
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              onClick={() => selectMemberProfile(viewer)}
            >
              → View profile
            </button>
          }
        />
      </section>
    </div>
  );
}

function Row({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action: preact.ComponentChildren;
}) {
  return (
    <div class="flex items-start justify-between gap-4 flex-wrap sm:flex-nowrap">
      <div class="min-w-0 flex-1">
        <div
          class="font-display"
          style="font-weight:700;font-size:14px;letter-spacing:-0.01em;color:var(--ink);line-height:1.2"
        >
          {title}
        </div>
        <div style="font-family:var(--f-sans);font-size:12.5px;color:var(--muted);line-height:1.45;margin-top:3px">
          {description}
        </div>
      </div>
      <div class="flex-shrink-0">{action}</div>
    </div>
  );
}

export function __resetAccountPanelForTests(): void {
  busy.value = null;
  accountReveal.value = null;
}
