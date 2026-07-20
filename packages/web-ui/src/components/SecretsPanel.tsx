/**
 * SecretsPanel — secrets.manage-gated registry of broker-held
 * environment secrets injected into agents at spawn.
 *
 * Mirrors ToolSourcesPanel: PageHeader with a "+ New secret" toggle,
 * an inline create form, and a `.panel` of hover rows linking through
 * to `/secrets/:slug`. The list signal lives in lib/secrets.ts and
 * refreshes live on `secret` channel events. Values are write-only —
 * nothing on this surface ever renders one.
 */

import { signal } from '@preact/signals';
import { SecretEnvNameSchema } from 'csuite-sdk/schemas';
import type { SecretSummary } from 'csuite-sdk/types';
import { hasPermission } from 'csuite-sdk/types';
import { useEffect } from 'preact/hooks';
import { briefing } from '../lib/briefing.js';
import { createSecret, loadSecrets, secrets, secretsError } from '../lib/secrets.js';
import { selectSecretDetail } from '../lib/view.js';
import { EmptyState, ErrorCallout, Loading, PageHeader } from './ui/index.js';

const formOpen = signal(false);
const formSlug = signal('');
const formEnvName = signal('');
const formDescription = signal('');
const formAllMembers = signal(false);
const formError = signal<string | null>(null);
const formBusy = signal(false);

export function SecretsPanel() {
  const b = briefing.value;

  useEffect(() => {
    void loadSecrets();
  }, []);

  if (!b) return <Loading label="Loading secrets…" />;

  if (!hasPermission(b.permissions, 'secrets.manage')) {
    return (
      <div
        class="flex-1 overflow-y-auto"
        style="padding:24px max(1rem,env(safe-area-inset-right)) 24px max(1rem,env(safe-area-inset-left))"
      >
        <ErrorCallout
          title="Restricted"
          message="Managing secrets requires the secrets.manage permission."
        />
      </div>
    );
  }

  const list = secrets.value;
  const err = secretsError.value;

  return (
    <div
      class="flex-1 overflow-y-auto"
      style="padding:24px max(1rem,env(safe-area-inset-right)) 32px max(1rem,env(safe-area-inset-left))"
    >
      <PageHeader
        eyebrow="Team"
        title="Secrets"
        subtitle="Broker-held environment secrets injected into agents at spawn — values never leave the broker."
        actions={
          <button
            type="button"
            class="btn btn-primary btn-sm"
            onClick={() => {
              formOpen.value = true;
              formError.value = null;
              formSlug.value = '';
              formEnvName.value = '';
              formDescription.value = '';
              formAllMembers.value = false;
            }}
            disabled={formBusy.value}
          >
            + New secret
          </button>
        }
      />

      {err !== null && (
        <ErrorCallout title="Failed to load secrets" message={err} style="margin-bottom:18px" />
      )}

      {formOpen.value && <CreateSecretForm />}

      {list === null && err === null && <Loading label="Loading…" />}

      {list !== null && list.length === 0 && (
        <EmptyState
          title="No secrets yet"
          message="Register an environment secret for your agents with + New secret."
        />
      )}

      {list !== null && list.length > 0 && (
        <div class="panel">
          <ul style="display:flex;flex-direction:column;list-style:none;padding:0;margin:0">
            {list.map((s, idx) => (
              <SecretListRow key={s.slug} secret={s} isLast={idx === list.length - 1} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function SecretListRow({ secret, isLast }: { secret: SecretSummary; isLast: boolean }) {
  const border = isLast ? '' : 'border-bottom:1px solid var(--rule);';
  return (
    <li>
      <button
        type="button"
        onClick={() => selectSecretDetail(secret.slug)}
        class="hover-row w-full flex items-center justify-between gap-3"
        style={`padding:14px 16px;${border};background:transparent;text-align:left;cursor:pointer`}
        aria-label={`Manage secret ${secret.slug}`}
      >
        <div class="min-w-0 flex items-center gap-3 flex-wrap">
          <span
            class="font-display"
            style="font-weight:700;letter-spacing:-0.01em;font-size:15px;color:var(--ink)"
          >
            {secret.slug}
          </span>
          <span style="font-family:var(--f-mono);font-size:11.5px;color:var(--muted);letter-spacing:.04em">
            ${secret.envName}
          </span>
          {!secret.enabled && <span class="badge muted">Disabled</span>}
          {secret.allMembers && <span class="badge soft">All members</span>}
          {secret.description.length > 0 && (
            <span style="font-family:var(--f-sans);font-size:12.5px;color:var(--muted)">
              {secret.description}
            </span>
          )}
        </div>
        <div class="flex items-center gap-3 flex-shrink-0">
          <span
            class={`dot ${secret.hasValue ? 'ok' : 'muted'}`}
            title={secret.hasValue ? 'Value set' : 'No value'}
          />
          <span style="font-family:var(--f-mono);font-size:11px;color:var(--muted);letter-spacing:.08em;text-transform:uppercase">
            → Manage
          </span>
        </div>
      </button>
    </li>
  );
}

function CreateSecretForm() {
  const err = formError.value;
  const busy = formBusy.value;

  async function onSubmit(e: Event): Promise<void> {
    e.preventDefault();
    const slug = formSlug.value.trim();
    if (!slug) {
      formError.value = 'Slug is required.';
      return;
    }
    const envName = formEnvName.value.trim();
    const validated = SecretEnvNameSchema.safeParse(envName);
    if (!validated.success) {
      formError.value = validated.error.issues[0]?.message ?? 'Env var name is invalid.';
      return;
    }
    formBusy.value = true;
    try {
      await createSecret({
        slug,
        envName,
        description: formDescription.value.trim(),
        allMembers: formAllMembers.value,
      });
      formOpen.value = false;
      selectSecretDetail(slug);
    } catch (ex) {
      formError.value = ex instanceof Error ? ex.message : String(ex);
    } finally {
      formBusy.value = false;
    }
  }

  return (
    <form class="panel" onSubmit={(e) => void onSubmit(e)} style="padding:16px;margin-bottom:18px">
      <div class="eyebrow" style="margin-bottom:10px">
        New secret
      </div>
      {err !== null && <ErrorCallout message={err} style="margin-bottom:10px" />}
      <div style="display:flex;flex-direction:column;gap:10px">
        <Labeled
          label="Slug"
          hint="Lowercase letters/digits/dashes. Immutable — it names the secret."
        >
          <input
            class="input"
            value={formSlug.value}
            onInput={(e) => {
              formSlug.value = (e.currentTarget as HTMLInputElement).value;
            }}
            placeholder="github-token"
          />
        </Labeled>
        <Labeled
          label="Env var name"
          hint="Uppercase POSIX name ([A-Z][A-Z0-9_]*) the runner sets on the agent. Reserved names are rejected."
        >
          <input
            class="input"
            value={formEnvName.value}
            onInput={(e) => {
              formEnvName.value = (e.currentTarget as HTMLInputElement).value;
            }}
            placeholder="GITHUB_TOKEN"
          />
        </Labeled>
        <Labeled label="Description" hint="Optional purpose note shown alongside the slug">
          <input
            class="input"
            value={formDescription.value}
            onInput={(e) => {
              formDescription.value = (e.currentTarget as HTMLInputElement).value;
            }}
            placeholder="Read-only PAT for the org's repos"
          />
        </Labeled>
        <label class="flex items-center gap-2" style="cursor:pointer">
          <input
            type="checkbox"
            class="check"
            checked={formAllMembers.value}
            onChange={(e) => {
              formAllMembers.value = (e.currentTarget as HTMLInputElement).checked;
            }}
          />
          <span style="font-family:var(--f-sans);font-size:13px;color:var(--ink)">
            Deliver to all members (skip per-member bindings)
          </span>
        </label>
      </div>
      <div class="flex items-center gap-2" style="margin-top:14px">
        <button type="submit" class="btn btn-primary btn-sm" disabled={busy}>
          {busy ? 'Registering…' : 'Register secret'}
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

export function __resetSecretsPanelForTests(): void {
  formOpen.value = false;
  formSlug.value = '';
  formEnvName.value = '';
  formDescription.value = '';
  formAllMembers.value = false;
  formError.value = null;
  formBusy.value = false;
}
