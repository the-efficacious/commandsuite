/**
 * Root component for csuite-web-host (OSS SPA).
 *
 * Owns the OSS-specific auth gate — session cookie bootstrap, TOTP
 * login screen, sign-out wiring — and then delegates the entire
 * in-team experience to `<TeamShell>` from csuite-web-ui.
 *
 * Gate states:
 *   - `loading`        → Boot splash while we call GET /session
 *   - `anonymous`      → Login screen (TOTP)
 *   - `authenticated`  → TeamShell, with OSS callbacks wired in
 */

import { TeamShell, ToastContainer } from 'csuite-web-ui';
import { useEffect } from 'preact/hooks';
import { getClient } from './lib/client.js';
import { bootstrap, logout, session } from './lib/session.js';
import { Boot } from './routes/Boot.js';
import { Enroll } from './routes/Enroll.js';
import { Login } from './routes/Login.js';

/**
 * Top-level routes that bypass TeamShell. The device-code enrollment
 * page is the only one today — operators land here from a CLI deep
 * link and the page handles its own auth gate (anonymous → Login,
 * non-admin → polite refusal, admin → approval form).
 *
 * `pathname === '/enroll'` is the exact match; sub-paths (`/enroll/foo`)
 * fall through to TeamShell so the in-shell router can resolve them.
 */
function isEnrollRoute(): boolean {
  if (typeof window === 'undefined') return false;
  return window.location.pathname === '/enroll';
}

export function App() {
  // Bootstrap once on mount. Empty dep array is intentional — we only
  // want this firing once per page load.
  useEffect(() => {
    void bootstrap();
  }, []);

  if (isEnrollRoute()) return <Enroll />;

  const state = session.value;
  if (state.status === 'loading') return <Boot />;
  if (state.status === 'anonymous') return <Login />;
  return (
    // `.app` activates dusk mode per the brand split (branding-guide-v7 §07):
    // operator surfaces run on a dark ground. Token remap cascades through
    // every child component automatically.
    <div class="app h-full flex flex-col">
      <TeamShell
        client={getClient()}
        identity={{
          member: state.member,
          role: state.role,
          permissions: state.permissions,
          expiresAt: state.expiresAt,
        }}
        onSignOut={() => logout()}
        onUnauthorized={(notice) => logout(notice)}
      />
      <ToastContainer />
    </div>
  );
}
