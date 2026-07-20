/**
 * Device-code enrollment approval page.
 *
 * The director-side counterpart to `csuite connect` on the operator's
 * VM. The flow:
 *
 *   1. Operator runs `csuite connect`, types out the URL+code shown.
 *   2. Director (this page) types the user code, looks up the
 *      pending request, sees the source IP / UA / labelHint.
 *   3. Director picks "bind to existing member" or "create a new
 *      member with role X / permissions Y," then approves.
 *   4. Server marks the row approved, mints the bearer token,
 *      KEK-wraps the plaintext briefly until the device polls.
 *
 * Anonymous landing → bounce to /login with a notice. Authenticated
 * but lacks `members.manage` → friendly "ask an admin" message.
 * Authenticated admin → the full approve form.
 *
 * URL deep links: `?code=KQ4M-7P2H` prefills the user-code field
 * and clears the parameter from history (so a screenshot of the
 * URL bar after navigation doesn't carry the code).
 */

import { signal } from '@preact/signals';
import type {
  ApproveEnrollmentRequest,
  PendingEnrollment,
  Permission,
  PermissionPresets,
  Teammate,
} from 'csuite-sdk/types';
import { ToastContainer } from 'csuite-web-ui';
import type { JSX } from 'preact';
import { useEffect } from 'preact/hooks';
import { getClient } from '../lib/client.js';
import { bootstrap, logout, session } from '../lib/session.js';
import { Boot } from './Boot.js';
import { Login } from './Login.js';

type Mode = 'bind' | 'create';

interface FormState {
  userCode: string;
  mode: Mode;
  bindMember: string;
  createName: string;
  createTitle: string;
  createDescription: string;
  createPermissions: string[];
  createInstructions: string;
  label: string;
}

const formState = signal<FormState>({
  userCode: '',
  mode: 'bind',
  bindMember: '',
  createName: '',
  createTitle: 'engineer',
  createDescription: '',
  createPermissions: [],
  createInstructions: '',
  label: '',
});

const lookupResult = signal<
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'found'; pending: PendingEnrollment }
  | { kind: 'not_found' }
  | { kind: 'expired' }
  | { kind: 'error'; message: string }
>({ kind: 'idle' });

const teammates = signal<Teammate[]>([]);
const permissionPresets = signal<PermissionPresets>({});
const submitting = signal<null | 'approve' | 'reject'>(null);
const successInfo = signal<{ memberName: string; userCode: string } | null>(null);

/**
 * Read `?code=` from the URL once, prefill the form, and clean up
 * history so the URL bar doesn't keep the code visible. Triggers
 * an automatic lookup so the director sees the pending row right
 * away.
 */
function consumeCodeParam(): string | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  if (!code) return null;
  params.delete('code');
  const next = params.toString();
  const url = `${window.location.pathname}${next.length > 0 ? `?${next}` : ''}${window.location.hash}`;
  window.history.replaceState(window.history.state, '', url);
  return code;
}

/**
 * Reload the team roster and team config (for permission presets) on
 * mount. Both are needed for the approve form: the bind dropdown
 * lists teammates, the create form's permissions selector lists
 * presets + leaf permissions.
 */
async function loadTeamContext(): Promise<void> {
  try {
    const [briefing, roster] = await Promise.all([getClient().briefing(), getClient().roster()]);
    teammates.value = roster.teammates;
    permissionPresets.value = briefing.team.permissionPresets;
    // Default the bind dropdown to the first non-self teammate so
    // the form is approve-ready without an extra click.
    if (formState.value.bindMember === '') {
      const self = briefing.name;
      const candidate = roster.teammates.find((t) => t.name !== self);
      if (candidate) {
        formState.value = { ...formState.value, bindMember: candidate.name };
      }
    }
  } catch (err) {
    // Non-fatal — the form still works, just without prefilled
    // dropdowns. Logged so a misconfigured deployment surfaces.
    console.warn('enroll: failed to load team context', err);
  }
}

async function lookupCode(rawCode: string): Promise<void> {
  const code = rawCode.trim().toUpperCase();
  if (!/^[0-9A-HJKMNP-TV-Z]{4}-?[0-9A-HJKMNP-TV-Z]{4}$/.test(code)) {
    lookupResult.value = {
      kind: 'error',
      message: 'codes are 8 characters from the Crockford alphabet (no I, L, O, U)',
    };
    return;
  }
  const formatted = code.includes('-') ? code : `${code.slice(0, 4)}-${code.slice(4)}`;
  lookupResult.value = { kind: 'loading' };
  try {
    const pendings = await getClient().listPendingEnrollments();
    const match = pendings.find((p) => p.userCode === formatted);
    if (!match) {
      lookupResult.value = { kind: 'not_found' };
      return;
    }
    if (match.expiresAt < Date.now()) {
      lookupResult.value = { kind: 'expired' };
      return;
    }
    lookupResult.value = { kind: 'found', pending: match };
    formState.value = {
      ...formState.value,
      userCode: formatted,
      label: match.labelHint,
    };
  } catch (err) {
    lookupResult.value = {
      kind: 'error',
      message: err instanceof Error ? err.message : 'lookup failed',
    };
  }
}

async function approve(): Promise<void> {
  const f = formState.value;
  const lr = lookupResult.value;
  if (lr.kind !== 'found') return;
  submitting.value = 'approve';
  try {
    let payload: ApproveEnrollmentRequest;
    if (f.mode === 'bind') {
      payload = {
        mode: 'bind',
        userCode: f.userCode,
        memberName: f.bindMember,
        ...(f.label.length > 0 ? { label: f.label } : {}),
      };
    } else {
      payload = {
        mode: 'create',
        userCode: f.userCode,
        memberName: f.createName,
        role: { title: f.createTitle, description: f.createDescription },
        instructions: f.createInstructions,
        permissions: f.createPermissions,
        ...(f.label.length > 0 ? { label: f.label } : {}),
      };
    }
    const result = await getClient().approveEnrollment(payload);
    successInfo.value = {
      memberName: result.member.name,
      userCode: f.userCode,
    };
    lookupResult.value = { kind: 'idle' };
    formState.value = {
      ...formState.value,
      userCode: '',
      bindMember: '',
      createName: '',
      label: '',
    };
  } catch (err) {
    lookupResult.value = {
      kind: 'error',
      message: err instanceof Error ? err.message : 'approve failed',
    };
  } finally {
    submitting.value = null;
  }
}

async function reject(): Promise<void> {
  const f = formState.value;
  const lr = lookupResult.value;
  if (lr.kind !== 'found') return;
  if (!confirm(`Reject enrollment ${f.userCode}?`)) return;
  submitting.value = 'reject';
  try {
    await getClient().rejectEnrollment({
      userCode: f.userCode,
      reason: 'rejected by director from web UI',
    });
    lookupResult.value = { kind: 'idle' };
    formState.value = { ...formState.value, userCode: '' };
  } catch (err) {
    lookupResult.value = {
      kind: 'error',
      message: err instanceof Error ? err.message : 'reject failed',
    };
  } finally {
    submitting.value = null;
  }
}

function permissionOptions(): string[] {
  // Presets first, leaf permissions after — matches the create-member
  // form's existing convention.
  const presetNames = Object.keys(permissionPresets.value);
  const leaves: Permission[] = [
    'team.manage',
    'members.manage',
    'objectives.create',
    'objectives.cancel',
    'objectives.reassign',
    'objectives.watch',
    'activity.read',
  ];
  return [...presetNames, ...leaves];
}

function togglePermission(p: string): void {
  const current = formState.value.createPermissions;
  formState.value = {
    ...formState.value,
    createPermissions: current.includes(p) ? current.filter((x) => x !== p) : [...current, p],
  };
}

function fmtCountdown(expiresAt: number): string {
  const seconds = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function Enroll(): JSX.Element {
  // Hydrate session on mount.
  useEffect(() => {
    void bootstrap();
    const initialCode = consumeCodeParam();
    if (initialCode) {
      formState.value = { ...formState.value, userCode: initialCode };
    }
  }, []);

  // Load team context once authenticated.
  useEffect(() => {
    if (session.value.status === 'authenticated') {
      void loadTeamContext();
      // Auto-lookup if we landed with a pre-filled code from a deep link.
      if (formState.value.userCode && lookupResult.value.kind === 'idle') {
        void lookupCode(formState.value.userCode);
      }
    }
  }, [session.value.status]);

  const state = session.value;
  if (state.status === 'loading') return <Boot />;
  if (state.status === 'anonymous') {
    return <Login />;
  }
  if (!state.permissions.includes('members.manage')) {
    return (
      <div class="app h-full flex flex-col">
        <main
          class="flex items-center justify-center"
          style="flex:1;min-height:0;overflow-y:auto;padding:24px"
        >
          <section class="card elev" style="max-width:480px;padding:32px;text-align:center">
            <div
              class="font-display"
              style="font-size:22px;font-weight:700;color:var(--ink);margin-bottom:8px"
            >
              Approval requires admin
            </div>
            <p style="color:var(--muted);font-size:14px;margin-bottom:20px">
              Your account doesn't have <code>members.manage</code>. Ask an admin to approve the
              enrollment, or sign in as an admin.
            </p>
            <button type="button" class="btn btn-ghost" onClick={() => void logout()}>
              Sign out
            </button>
          </section>
        </main>
      </div>
    );
  }

  // The body has `overflow: hidden; position: fixed` (see
  // theme.css:101) so the document itself never scrolls — every
  // route owns its own scroll container. Here, `<main>` is the
  // scroller: `flex:1 min-height:0` lets it fill the column inside
  // `.app`, and `overflow-y:auto` exposes the scrollbar when the
  // approval form (especially the "create new member" branch with
  // its permissions grid) grows past the viewport.
  return (
    <div class="app h-full flex flex-col">
      <main style="flex:1;min-height:0;overflow-y:auto;padding:32px max(1rem, 5vw)">
        <header style="max-width:720px;margin:0 auto 24px">
          <div
            class="eyebrow"
            style="font-family:var(--f-mono);font-size:11px;letter-spacing:.14em;color:var(--muted);text-transform:uppercase;margin-bottom:6px"
          >
            Device enrollment
          </div>
          <h1
            class="font-display"
            style="font-size:28px;font-weight:700;letter-spacing:-0.02em;color:var(--ink);margin:0 0 6px"
          >
            Approve a connecting device
          </h1>
          <p style="color:var(--muted);font-size:14px;margin:0">
            An operator running <code>csuite connect</code> on a VM gets a short code. Enter it
            here, pick who they're connecting as, and approve. The bearer token never leaves the
            broker — it goes straight to the device on its next poll.
          </p>
        </header>

        {successInfo.value && (
          <div
            class="card elev"
            style="max-width:720px;margin:0 auto 16px;padding:16px;border-left:3px solid var(--steel);background:rgba(56,178,116,0.06)"
          >
            <div style="font-family:var(--f-mono);font-size:11px;letter-spacing:.08em;color:var(--steel);text-transform:uppercase;margin-bottom:4px">
              Approved
            </div>
            <div style="font-size:14px;color:var(--ink)">
              Code <strong style="font-family:var(--f-mono)">{successInfo.value.userCode}</strong>{' '}
              bound to <strong>{successInfo.value.memberName}</strong>. The device's CLI will
              receive its bearer token on the next poll.
            </div>
          </div>
        )}

        <CodeEntryCard onLookup={(c) => void lookupCode(c)} />
        <ApprovalCard onApprove={() => void approve()} onReject={() => void reject()} />
      </main>
      <ToastContainer />
    </div>
  );
}

function CodeEntryCard({ onLookup }: { onLookup: (code: string) => void }): JSX.Element {
  const value = formState.value.userCode;
  const result = lookupResult.value;
  function onSubmit(e: Event) {
    e.preventDefault();
    if (value.trim().length === 0) return;
    onLookup(value);
  }
  return (
    <section class="card elev" style="max-width:720px;margin:0 auto 16px;padding:24px">
      <form onSubmit={onSubmit} style="display:flex;flex-direction:column;gap:14px">
        <label style="display:flex;flex-direction:column;gap:6px">
          <span style="font-family:var(--f-mono);font-size:11px;letter-spacing:.08em;color:var(--muted);text-transform:uppercase">
            User code
          </span>
          <input
            class="input"
            value={value}
            onInput={(e) =>
              (formState.value = {
                ...formState.value,
                userCode: (e.currentTarget as HTMLInputElement).value.toUpperCase(),
              })
            }
            placeholder="XXXX-XXXX"
            autoComplete="off"
            spellcheck={false}
            style="font-family:var(--f-mono);font-size:22px;letter-spacing:.18em;text-align:center;padding:12px"
          />
        </label>
        <button
          type="submit"
          class="btn btn-primary"
          disabled={value.trim().length === 0 || result.kind === 'loading'}
        >
          {result.kind === 'loading' ? 'Looking up…' : 'Look up code'}
        </button>
      </form>
      {result.kind === 'not_found' && (
        <div
          role="alert"
          class="callout warn"
          style="margin-top:14px;padding:10px 12px;font-size:13px"
        >
          No pending enrollment matches that code. It may have expired (5 min TTL) or been consumed
          already. Ask the operator to run <code>csuite connect</code> again.
        </div>
      )}
      {result.kind === 'expired' && (
        <div
          role="alert"
          class="callout warn"
          style="margin-top:14px;padding:10px 12px;font-size:13px"
        >
          That enrollment has expired. Ask the operator to run <code>csuite connect</code> again.
        </div>
      )}
      {result.kind === 'error' && (
        <div
          role="alert"
          class="callout err"
          style="margin-top:14px;padding:10px 12px;font-size:13px"
        >
          {result.message}
        </div>
      )}
    </section>
  );
}

function ApprovalCard({
  onApprove,
  onReject,
}: {
  onApprove: () => void;
  onReject: () => void;
}): JSX.Element | null {
  const result = lookupResult.value;
  if (result.kind !== 'found') return null;
  const f = formState.value;
  const pending = result.pending;
  const isSubmitting = submitting.value !== null;

  function setField<K extends keyof FormState>(key: K, value: FormState[K]) {
    formState.value = { ...formState.value, [key]: value };
  }

  const canApprove =
    !isSubmitting &&
    (f.mode === 'bind'
      ? f.bindMember.length > 0
      : f.createName.length > 0 && f.createTitle.length > 0);

  return (
    <section class="card elev" style="max-width:720px;margin:0 auto;padding:24px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px">
        <div>
          <div style="font-family:var(--f-mono);font-size:11px;letter-spacing:.08em;color:var(--muted);text-transform:uppercase">
            Pending enrollment
          </div>
          <div style="font-family:var(--f-mono);font-size:22px;letter-spacing:.18em;color:var(--ink);margin-top:2px">
            {pending.userCode}
          </div>
        </div>
        <div style="font-family:var(--f-mono);font-size:12px;color:var(--muted);text-align:right">
          <div>expires in {fmtCountdown(pending.expiresAt)}</div>
        </div>
      </div>

      <dl style="display:grid;grid-template-columns:max-content 1fr;gap:6px 14px;font-size:13px;color:var(--muted);margin-bottom:18px">
        <dt>source ip</dt>
        <dd style="color:var(--ink);font-family:var(--f-mono)">{pending.sourceIp ?? '—'}</dd>
        <dt>user-agent</dt>
        <dd style="color:var(--ink);font-family:var(--f-mono);overflow-wrap:anywhere">
          {pending.sourceUa ?? '—'}
        </dd>
        <dt>label hint</dt>
        <dd style="color:var(--ink)">{pending.labelHint || '(none)'}</dd>
      </dl>

      <fieldset style="border:none;padding:0;margin:0 0 14px;display:flex;flex-direction:column;gap:8px">
        <legend style="font-family:var(--f-mono);font-size:11px;letter-spacing:.08em;color:var(--muted);text-transform:uppercase;margin-bottom:4px">
          Bind to
        </legend>
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input
            type="radio"
            name="enroll-mode"
            checked={f.mode === 'bind'}
            onChange={() => setField('mode', 'bind')}
          />
          <span>Existing member</span>
        </label>
        {f.mode === 'bind' && (
          <select
            class="input"
            value={f.bindMember}
            onChange={(e) => setField('bindMember', (e.currentTarget as HTMLSelectElement).value)}
            style="margin-left:24px;width:auto"
          >
            <option value="" disabled>
              choose a member
            </option>
            {teammates.value.map((t) => (
              <option value={t.name} key={t.name}>
                {t.name} ({t.role.title})
              </option>
            ))}
          </select>
        )}
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input
            type="radio"
            name="enroll-mode"
            checked={f.mode === 'create'}
            onChange={() => setField('mode', 'create')}
          />
          <span>New member</span>
        </label>
        {f.mode === 'create' && (
          <div style="margin-left:24px;display:flex;flex-direction:column;gap:10px;padding:10px 0">
            <label style="display:flex;flex-direction:column;gap:4px">
              <span style="font-family:var(--f-mono);font-size:11px;letter-spacing:.04em;color:var(--muted);text-transform:uppercase">
                name
              </span>
              <input
                class="input"
                value={f.createName}
                onInput={(e) => setField('createName', (e.currentTarget as HTMLInputElement).value)}
                placeholder="alice"
                autoComplete="off"
              />
            </label>
            <label style="display:flex;flex-direction:column;gap:4px">
              <span style="font-family:var(--f-mono);font-size:11px;letter-spacing:.04em;color:var(--muted);text-transform:uppercase">
                role title
              </span>
              <input
                class="input"
                value={f.createTitle}
                onInput={(e) =>
                  setField('createTitle', (e.currentTarget as HTMLInputElement).value)
                }
                autoComplete="off"
              />
            </label>
            <label style="display:flex;flex-direction:column;gap:4px">
              <span style="font-family:var(--f-mono);font-size:11px;letter-spacing:.04em;color:var(--muted);text-transform:uppercase">
                role description
              </span>
              <input
                class="input"
                value={f.createDescription}
                onInput={(e) =>
                  setField('createDescription', (e.currentTarget as HTMLInputElement).value)
                }
                placeholder="ships code"
                autoComplete="off"
              />
            </label>
            <label style="display:flex;flex-direction:column;gap:4px">
              <span style="font-family:var(--f-mono);font-size:11px;letter-spacing:.04em;color:var(--muted);text-transform:uppercase">
                instructions
              </span>
              <textarea
                class="input"
                rows={3}
                value={f.createInstructions}
                onInput={(e) =>
                  setField('createInstructions', (e.currentTarget as HTMLTextAreaElement).value)
                }
                placeholder="Standing guidance for this member — how they should work, what to prioritize."
                autoComplete="off"
              />
            </label>
            <fieldset style="border:none;padding:0;margin:0;display:flex;flex-direction:column;gap:6px">
              <legend style="font-family:var(--f-mono);font-size:11px;letter-spacing:.04em;color:var(--muted);text-transform:uppercase;margin-bottom:4px">
                permissions
              </legend>
              <div style="display:flex;flex-wrap:wrap;gap:6px;font-family:var(--f-mono);font-size:12px">
                {permissionOptions().map((p) => (
                  <label
                    key={p}
                    style="display:inline-flex;align-items:center;gap:6px;padding:4px 8px;border:1px solid var(--rule);border-radius:var(--r-sm);cursor:pointer"
                  >
                    <input
                      type="checkbox"
                      checked={f.createPermissions.includes(p)}
                      onChange={() => togglePermission(p)}
                    />
                    {p}
                  </label>
                ))}
              </div>
            </fieldset>
          </div>
        )}
      </fieldset>

      <label style="display:flex;flex-direction:column;gap:4px;margin-bottom:18px">
        <span style="font-family:var(--f-mono);font-size:11px;letter-spacing:.04em;color:var(--muted);text-transform:uppercase">
          token label (optional)
        </span>
        <input
          class="input"
          value={f.label}
          onInput={(e) => setField('label', (e.currentTarget as HTMLInputElement).value)}
          placeholder={pending.labelHint || 'e.g. prod-vm-east'}
          autoComplete="off"
        />
      </label>

      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button
          type="button"
          class="btn btn-ghost"
          onClick={() => onReject()}
          disabled={isSubmitting}
          style="color:var(--err)"
        >
          {submitting.value === 'reject' ? 'Rejecting…' : 'Reject'}
        </button>
        <button
          type="button"
          class="btn btn-primary"
          onClick={() => onApprove()}
          disabled={!canApprove}
        >
          {submitting.value === 'approve' ? 'Approving…' : 'Approve'}
        </button>
      </div>
    </section>
  );
}

export function __resetEnrollStateForTests(): void {
  formState.value = {
    userCode: '',
    mode: 'bind',
    bindMember: '',
    createName: '',
    createTitle: 'engineer',
    createDescription: '',
    createPermissions: [],
    createInstructions: '',
    label: '',
  };
  lookupResult.value = { kind: 'idle' };
  teammates.value = [];
  permissionPresets.value = {};
  submitting.value = null;
  successInfo.value = null;
}
