/**
 * NotificationsPanel — notifications.manage-gated registry of
 * External Notification endpoints (inbound webhooks → agents), plus
 * the shared auth profiles several endpoints can verify against.
 *
 * Mirrors SecretsPanel: PageHeader with a "+ New endpoint" toggle, an
 * inline create form, a `.panel` of hover rows linking through to
 * `/notifications/:slug`, and a Profiles panel below. The list signal
 * lives in lib/notifications.ts and refreshes live on
 * `notification_endpoint` channel events. Signing secrets are
 * write-only — nothing on this surface ever renders one.
 */

import { signal } from '@preact/signals';
import { NotificationSlugSchema } from 'csuite-sdk/schemas';
import type {
  NotificationAuthKind,
  NotificationEndpointSummary,
  NotificationProfileSummary,
  NotificationTarget,
} from 'csuite-sdk/types';
import { hasPermission } from 'csuite-sdk/types';
import { useEffect } from 'preact/hooks';
import { briefing } from '../lib/briefing.js';
import {
  createNotificationEndpoint,
  createNotificationProfile,
  deleteNotificationProfile,
  loadNotificationEndpoints,
  loadNotificationProfiles,
  notificationEndpoints,
  notificationProfiles,
  notificationsError,
  setNotificationProfileSecret,
} from '../lib/notifications.js';
import { selectNotificationDetail } from '../lib/view.js';
import { EmptyState, ErrorCallout, Loading, PageHeader } from './ui/index.js';

const formOpen = signal(false);
const formSlug = signal('');
const formTargets = signal('');
const formAuthKind = signal<NotificationAuthKind>('hmac-sha256');
const formDescription = signal('');
const formError = signal<string | null>(null);
const formBusy = signal(false);

const profileFormOpen = signal(false);
const profileSlug = signal('');
const profileAuthKind = signal<NotificationAuthKind>('hmac-sha256');
const profileError = signal<string | null>(null);
const profileBusy = signal<string | null>(null);
const profileSecretFor = signal<string | null>(null);
const profileSecretInput = signal('');

/** Parse "@member #channel bare-member" (whitespace/comma separated). */
export function parseTargetsInput(raw: string): NotificationTarget[] {
  return raw
    .split(/[\s,]+/)
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      if (entry.startsWith('#')) return { channel: entry.slice(1) };
      return { member: entry.startsWith('@') ? entry.slice(1) : entry };
    });
}

export function describeTarget(t: NotificationTarget): string {
  return t.member !== undefined ? `@${t.member}` : `#${t.channel ?? '?'}`;
}

export function NotificationsPanel() {
  const b = briefing.value;

  useEffect(() => {
    void loadNotificationEndpoints();
    loadNotificationProfiles().catch(() => {
      /* surfaced by the endpoints error path on a broken broker */
    });
  }, []);

  if (!b) return <Loading label="Loading notifications…" />;

  if (!hasPermission(b.permissions, 'notifications.manage')) {
    return (
      <div
        class="flex-1 overflow-y-auto"
        style="padding:24px max(1rem,env(safe-area-inset-right)) 24px max(1rem,env(safe-area-inset-left))"
      >
        <ErrorCallout
          title="Restricted"
          message="Managing external notifications requires the notifications.manage permission."
        />
      </div>
    );
  }

  const list = notificationEndpoints.value;
  const err = notificationsError.value;

  return (
    <div
      class="flex-1 overflow-y-auto"
      style="padding:24px max(1rem,env(safe-area-inset-right)) 32px max(1rem,env(safe-area-inset-left))"
    >
      <PageHeader
        eyebrow="Team"
        title="Notifications"
        subtitle="Inbound webhooks and API calls, verified at /hooks/<slug> and routed to members and channels as ambient input."
        actions={
          <button
            type="button"
            class="btn btn-primary btn-sm"
            onClick={() => {
              formOpen.value = true;
              formError.value = null;
              formSlug.value = '';
              formTargets.value = '';
              formAuthKind.value = 'hmac-sha256';
              formDescription.value = '';
            }}
            disabled={formBusy.value}
          >
            + New endpoint
          </button>
        }
      />

      {err !== null && (
        <ErrorCallout title="Failed to load endpoints" message={err} style="margin-bottom:18px" />
      )}

      {formOpen.value && <CreateEndpointForm />}

      {list === null && err === null && <Loading label="Loading…" />}

      {list !== null && list.length === 0 && (
        <EmptyState
          title="No endpoints yet"
          message="Register an inbound endpoint with + New endpoint, set its signing secret, then point the sender at /hooks/<slug>."
        />
      )}

      {list !== null && list.length > 0 && (
        <div class="panel">
          <ul style="display:flex;flex-direction:column;list-style:none;padding:0;margin:0">
            {list.map((e, idx) => (
              <EndpointListRow key={e.slug} endpoint={e} isLast={idx === list.length - 1} />
            ))}
          </ul>
        </div>
      )}

      <ProfilesSection />
    </div>
  );
}

function EndpointListRow({
  endpoint,
  isLast,
}: {
  endpoint: NotificationEndpointSummary;
  isLast: boolean;
}) {
  const border = isLast ? '' : 'border-bottom:1px solid var(--rule);';
  const verifiable = endpoint.hasSecret || endpoint.authProfile !== null;
  return (
    <li>
      <button
        type="button"
        onClick={() => selectNotificationDetail(endpoint.slug)}
        class="hover-row w-full flex items-center justify-between gap-3"
        style={`padding:14px 16px;${border};background:transparent;text-align:left;cursor:pointer`}
        aria-label={`Manage endpoint ${endpoint.slug}`}
      >
        <div class="min-w-0 flex items-center gap-3 flex-wrap">
          <span
            class="font-display"
            style="font-weight:700;letter-spacing:-0.01em;font-size:15px;color:var(--ink)"
          >
            {endpoint.slug}
          </span>
          <span style="font-family:var(--f-mono);font-size:11.5px;color:var(--muted);letter-spacing:.04em">
            {endpoint.targets.map(describeTarget).join(' ')}
          </span>
          {!endpoint.enabled && <span class="badge muted">Disabled</span>}
          {endpoint.authProfile !== null && (
            <span class="badge soft">profile:{endpoint.authProfile}</span>
          )}
          {endpoint.policy.ifOffline === 'queue' && <span class="badge soft">Queue offline</span>}
          {endpoint.policy.debounceMs > 0 && <span class="badge soft">Debounce</span>}
          {!verifiable && <span class="badge ember solid">No secret</span>}
        </div>
        <div class="flex items-center gap-3 flex-shrink-0">
          <span
            class={`dot ${verifiable ? 'ok' : 'muted'}`}
            title={verifiable ? 'Verifiable' : 'No secret — rejects everything'}
          />
          <span style="font-family:var(--f-mono);font-size:11px;color:var(--muted);letter-spacing:.08em;text-transform:uppercase">
            → Manage
          </span>
        </div>
      </button>
    </li>
  );
}

function CreateEndpointForm() {
  const err = formError.value;
  const busy = formBusy.value;

  async function onSubmit(e: Event): Promise<void> {
    e.preventDefault();
    const slug = formSlug.value.trim();
    const validated = NotificationSlugSchema.safeParse(slug);
    if (!validated.success) {
      formError.value = validated.error.issues[0]?.message ?? 'Slug is invalid.';
      return;
    }
    const targets = parseTargetsInput(formTargets.value);
    if (targets.length === 0) {
      formError.value = 'At least one target is required (@member or #channel).';
      return;
    }
    formBusy.value = true;
    try {
      await createNotificationEndpoint({
        slug,
        targets,
        auth: { kind: formAuthKind.value },
        ...(formDescription.value.trim().length > 0
          ? { description: formDescription.value.trim() }
          : {}),
      });
      formOpen.value = false;
      selectNotificationDetail(slug);
    } catch (ex) {
      formError.value = ex instanceof Error ? ex.message : String(ex);
    } finally {
      formBusy.value = false;
    }
  }

  return (
    <form class="panel" onSubmit={(e) => void onSubmit(e)} style="padding:16px;margin-bottom:18px">
      <div class="eyebrow" style="margin-bottom:10px">
        New endpoint
      </div>
      {err !== null && <ErrorCallout message={err} style="margin-bottom:10px" />}
      <div style="display:flex;flex-direction:column;gap:10px">
        <Labeled
          label="Slug"
          hint="Lowercase letters/digits/dashes. Immutable — it is the ingress URL (/hooks/<slug>)."
        >
          <input
            class="input"
            value={formSlug.value}
            onInput={(e) => {
              formSlug.value = (e.currentTarget as HTMLInputElement).value;
            }}
            placeholder="ci-alerts"
          />
        </Labeled>
        <Labeled
          label="Targets"
          hint="Space-separated: @member for a DM copy, #channel for a channel post."
        >
          <input
            class="input"
            value={formTargets.value}
            onInput={(e) => {
              formTargets.value = (e.currentTarget as HTMLInputElement).value;
            }}
            placeholder="@builder #ops"
          />
        </Labeled>
        <Labeled
          label="Verification"
          hint="hmac-sha256 defaults are GitHub-compatible; header-secret carries a shared secret verbatim. Configurable in detail after creation."
        >
          <select
            class="select"
            value={formAuthKind.value}
            onChange={(e) => {
              formAuthKind.value = (e.currentTarget as HTMLSelectElement)
                .value as NotificationAuthKind;
            }}
          >
            <option value="hmac-sha256">HMAC-SHA256 (signed body)</option>
            <option value="header-secret">Shared-secret header</option>
          </select>
        </Labeled>
        <Labeled label="Description" hint="Optional purpose note shown alongside the slug">
          <input
            class="input"
            value={formDescription.value}
            onInput={(e) => {
              formDescription.value = (e.currentTarget as HTMLInputElement).value;
            }}
            placeholder="GitHub CI failures for the main repo"
          />
        </Labeled>
      </div>
      <div class="flex items-center gap-2" style="margin-top:14px">
        <button type="submit" class="btn btn-primary btn-sm" disabled={busy}>
          {busy ? 'Registering…' : 'Register endpoint'}
        </button>
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          onClick={() => {
            formOpen.value = false;
            formError.value = null;
          }}
          disabled={busy}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function ProfilesSection() {
  const profiles = notificationProfiles.value;
  const err = profileError.value;
  const busy = profileBusy.value;

  async function run(label: string, fn: () => Promise<unknown>): Promise<void> {
    profileBusy.value = label;
    profileError.value = null;
    try {
      await fn();
    } catch (ex) {
      profileError.value = ex instanceof Error ? ex.message : String(ex);
    } finally {
      profileBusy.value = null;
    }
  }

  return (
    <section class="panel" style="padding:16px;margin-top:18px">
      <div class="flex items-center justify-between gap-3" style="margin-bottom:10px">
        <div class="eyebrow">Auth profiles</div>
        <button
          type="button"
          class="btn btn-secondary btn-sm"
          onClick={() => {
            profileFormOpen.value = !profileFormOpen.value;
            profileError.value = null;
            profileSlug.value = '';
            profileAuthKind.value = 'hmac-sha256';
          }}
        >
          {profileFormOpen.value ? 'Cancel' : '+ New profile'}
        </button>
      </div>
      <div style="font-family:var(--f-sans);font-size:12.5px;color:var(--muted);margin-bottom:12px">
        A profile holds one verification scheme + secret shared by several endpoints — rotating the
        sender's secret is a single write. Deleting a profile still referenced by an endpoint is
        refused.
      </div>

      {err !== null && (
        <ErrorCallout
          message={err}
          style="margin-bottom:10px"
          onDismiss={() => {
            profileError.value = null;
          }}
        />
      )}

      {profileFormOpen.value && (
        <form
          class="flex items-end gap-2 flex-wrap"
          style="margin-bottom:12px"
          onSubmit={(e) => {
            e.preventDefault();
            const slug = profileSlug.value.trim();
            const validated = NotificationSlugSchema.safeParse(slug);
            if (!validated.success) {
              profileError.value = validated.error.issues[0]?.message ?? 'Slug is invalid.';
              return;
            }
            void run('create', async () => {
              await createNotificationProfile({
                slug,
                auth: { kind: profileAuthKind.value },
              });
              profileFormOpen.value = false;
              profileSecretFor.value = slug;
            });
          }}
        >
          <div class="field" style="margin:0;min-width:160px">
            <label class="field-label" for="profile-slug">
              Slug
            </label>
            <input
              id="profile-slug"
              class="input"
              value={profileSlug.value}
              onInput={(e) => {
                profileSlug.value = (e.currentTarget as HTMLInputElement).value;
              }}
              placeholder="gh-org"
            />
          </div>
          <div class="field" style="margin:0">
            <label class="field-label" for="profile-kind">
              Scheme
            </label>
            <select
              id="profile-kind"
              class="select"
              value={profileAuthKind.value}
              onChange={(e) => {
                profileAuthKind.value = (e.currentTarget as HTMLSelectElement)
                  .value as NotificationAuthKind;
              }}
            >
              <option value="hmac-sha256">HMAC-SHA256</option>
              <option value="header-secret">Shared-secret header</option>
            </select>
          </div>
          <button type="submit" class="btn btn-primary btn-sm" disabled={busy !== null}>
            {busy === 'create' ? 'Creating…' : 'Create profile'}
          </button>
        </form>
      )}

      {profiles !== null && profiles.length === 0 && (
        <div style="font-family:var(--f-sans);font-size:13px;color:var(--muted)">
          No profiles yet.
        </div>
      )}

      {profiles !== null && profiles.length > 0 && (
        <ul style="display:flex;flex-direction:column;gap:8px;list-style:none;padding:0;margin:0">
          {profiles.map((p) => (
            <ProfileRow key={p.slug} profile={p} run={run} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ProfileRow({
  profile,
  run,
}: {
  profile: NotificationProfileSummary;
  run: (label: string, fn: () => Promise<unknown>) => Promise<void>;
}) {
  const busy = profileBusy.value;
  const secretOpen = profileSecretFor.value === profile.slug;
  const refs = `${profile.endpointCount} endpoint${profile.endpointCount === 1 ? '' : 's'}`;

  return (
    <li
      class="flex flex-col gap-2"
      style="border:1px solid var(--rule);border-radius:var(--r-xs);padding:10px 12px"
    >
      <div class="flex items-center justify-between gap-3 flex-wrap">
        <div class="flex items-center gap-3 flex-wrap">
          <span class="font-display" style="font-weight:700;font-size:14px;color:var(--ink)">
            {profile.slug}
          </span>
          <span style="font-family:var(--f-mono);font-size:11px;color:var(--muted)">
            {profile.auth.kind} · {refs}
          </span>
          <span
            class={`dot ${profile.hasSecret ? 'ok' : 'muted'}`}
            title={profile.hasSecret ? 'Secret set' : 'No secret'}
          />
        </div>
        <div class="flex items-center gap-2">
          <button
            type="button"
            class="btn btn-secondary btn-sm"
            disabled={busy !== null}
            onClick={() => {
              profileSecretFor.value = secretOpen ? null : profile.slug;
              profileSecretInput.value = '';
            }}
          >
            {profile.hasSecret ? 'Rotate secret' : 'Set secret'}
          </button>
          <button
            type="button"
            class="btn btn-destructive btn-sm"
            disabled={busy !== null || profile.endpointCount > 0}
            title={profile.endpointCount > 0 ? 'Repoint referencing endpoints first' : undefined}
            onClick={() =>
              void run(`delete-${profile.slug}`, () => deleteNotificationProfile(profile.slug))
            }
          >
            Delete
          </button>
        </div>
      </div>
      {secretOpen && (
        <form
          class="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (profileSecretInput.value.length === 0) {
              profileError.value = 'Secret is required.';
              return;
            }
            void run(`secret-${profile.slug}`, async () => {
              await setNotificationProfileSecret(profile.slug, profileSecretInput.value);
              profileSecretInput.value = '';
              profileSecretFor.value = null;
            });
          }}
        >
          <input
            class="input flex-1"
            type="password"
            value={profileSecretInput.value}
            onInput={(e) => {
              profileSecretInput.value = (e.currentTarget as HTMLInputElement).value;
            }}
            placeholder="Paste shared secret… (write-only; re-keys every referencing endpoint)"
            autocomplete="off"
            aria-label={`Secret for profile ${profile.slug}`}
          />
          <button type="submit" class="btn btn-primary btn-sm" disabled={busy !== null}>
            {busy === `secret-${profile.slug}` ? 'Saving…' : 'Save'}
          </button>
        </form>
      )}
    </li>
  );
}

function Labeled({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: preact.ComponentChildren;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the input/select/textarea is passed in as a child
    <label style="display:flex;flex-direction:column;gap:4px">
      <div class="eyebrow">{label}</div>
      {children}
      <div style="font-family:var(--f-sans);font-size:11.5px;color:var(--muted);font-style:italic">
        {hint}
      </div>
    </label>
  );
}

export function __resetNotificationsPanelForTests(): void {
  formOpen.value = false;
  formSlug.value = '';
  formTargets.value = '';
  formAuthKind.value = 'hmac-sha256';
  formDescription.value = '';
  formError.value = null;
  formBusy.value = false;
  profileFormOpen.value = false;
  profileSlug.value = '';
  profileAuthKind.value = 'hmac-sha256';
  profileError.value = null;
  profileBusy.value = null;
  profileSecretFor.value = null;
  profileSecretInput.value = '';
}
