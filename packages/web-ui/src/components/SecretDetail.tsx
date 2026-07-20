/**
 * SecretDetail — manage one secret: its metadata (env var name +
 * description), member access, write-only value, and lifecycle
 * (enable/disable/delete).
 *
 * Gated on secrets.manage like the list panel. Sections are `.panel`s
 * with `.eyebrow` headings; mutations go through lib/secrets.ts
 * wrappers (which re-list + re-fetch the detail), and errors surface
 * inline per-section rather than as toasts.
 *
 * The value is write-only end to end: reads only expose `hasValue`,
 * the set/replace input is type=password, and it's cleared on submit.
 * The env var name is validated client-side with the SDK schema so
 * reserved names fail with a message before hitting the server.
 */

import { signal } from '@preact/signals';
import { SecretEnvNameSchema } from 'csuite-sdk/schemas';
import type { SecretSummary } from 'csuite-sdk/types';
import { hasPermission } from 'csuite-sdk/types';
import { useEffect } from 'preact/hooks';
import { briefing } from '../lib/briefing.js';
import {
  bindSecret,
  deleteSecret,
  deleteSecretValue,
  loadSecretDetail,
  loadSecrets,
  secretBySlug,
  secretDetails,
  secrets,
  setSecretValue,
  unbindSecret,
  updateSecret,
} from '../lib/secrets.js';
import { selectSecrets } from '../lib/view.js';
import { KeyRound } from './icons/index.js';
import { ErrorCallout, Loading } from './ui/index.js';

const sectionError = signal<string | null>(null);
const sectionBusy = signal<string | null>(null);
const detailError = signal<string | null>(null);

const metaEnvName = signal('');
const metaDescription = signal('');
// Slug the metadata form was last seeded for — refreshAfterMutation
// re-fetches the summary, and re-seeding then would clobber edits.
const metaSeededFor = signal<string | null>(null);

const valueInput = signal('');

const bindName = signal('');

const confirmDelete = signal(false);

async function run(label: string, fn: () => Promise<unknown>): Promise<void> {
  sectionBusy.value = label;
  sectionError.value = null;
  try {
    await fn();
  } catch (err) {
    sectionError.value = err instanceof Error ? err.message : String(err);
  } finally {
    sectionBusy.value = null;
  }
}

export function SecretDetail({ slug }: { slug: string }) {
  const b = briefing.value;
  const secret = secretBySlug(slug);

  useEffect(() => {
    detailError.value = null;
    confirmDelete.value = false;
    metaSeededFor.value = null;
    valueInput.value = '';
    if (secrets.value === null) void loadSecrets();
    loadSecretDetail(slug).catch((err) => {
      detailError.value = err instanceof Error ? err.message : String(err);
    });
  }, [slug]);

  // Seed the metadata form once per slug, after the summary loads.
  useEffect(() => {
    if (secret !== null && metaSeededFor.value !== slug) {
      metaEnvName.value = secret.envName;
      metaDescription.value = secret.description;
      metaSeededFor.value = slug;
    }
  }, [slug, secret]);

  if (!b) return <Loading label="Loading…" />;

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

  const detail = secretDetails.value[slug] ?? null;
  const loadErr = detailError.value;

  return (
    <div
      class="flex-1 overflow-y-auto"
      style="padding:24px max(1rem,env(safe-area-inset-right)) 32px max(1rem,env(safe-area-inset-left))"
    >
      <nav class="crumbs" style="margin-bottom:14px">
        <button type="button" class="text-link" onClick={selectSecrets}>
          ← Secrets
        </button>
        <span class="sep">/</span>
        <span class="current">{slug}</span>
      </nav>

      {loadErr !== null && (
        <ErrorCallout title="Failed to load secret" message={loadErr} style="margin-bottom:18px" />
      )}

      {secret === null && loadErr === null && <Loading label="Loading secret…" />}

      {secret !== null && (
        <>
          <header style="margin-bottom:20px">
            <div class="flex items-center gap-3 flex-wrap">
              <h2
                class="font-display"
                style="margin:0;font-size:26px;font-weight:800;letter-spacing:-0.02em;color:var(--ink)"
              >
                {secret.slug}
              </h2>
              <span class={`badge ${secret.enabled ? 'soft' : 'muted'}`}>
                {secret.enabled ? 'Enabled' : 'Disabled'}
              </span>
            </div>
            <div style="margin-top:6px;font-family:var(--f-mono);font-size:11.5px;color:var(--muted);letter-spacing:.04em">
              ${secret.envName} · registered by {secret.createdBy}
              {secret.description.length > 0 ? ` · ${secret.description}` : ''}
            </div>
          </header>

          {sectionError.value !== null && (
            <ErrorCallout
              message={sectionError.value}
              style="margin-bottom:16px"
              onDismiss={() => {
                sectionError.value = null;
              }}
            />
          )}

          <MetadataSection secret={secret} />
          <AccessSection secret={secret} boundMembers={detail?.boundMembers ?? []} />
          <ValueSection secret={secret} />
          <LifecycleSection secret={secret} />
        </>
      )}
    </div>
  );
}

function SectionPanel({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: preact.ComponentChildren;
  children: preact.ComponentChildren;
}) {
  return (
    <section class="panel" style="padding:16px;margin-bottom:16px">
      <div class="flex items-center justify-between gap-3" style="margin-bottom:10px">
        <div class="eyebrow">{title}</div>
        {actions}
      </div>
      {children}
    </section>
  );
}

function MetadataSection({ secret }: { secret: SecretSummary }) {
  const busy = sectionBusy.value;

  async function onSubmit(e: Event): Promise<void> {
    e.preventDefault();
    const envName = metaEnvName.value.trim();
    const validated = SecretEnvNameSchema.safeParse(envName);
    if (!validated.success) {
      sectionError.value = validated.error.issues[0]?.message ?? 'Env var name is invalid.';
      return;
    }
    await run('meta-save', () =>
      updateSecret(secret.slug, { envName, description: metaDescription.value.trim() }),
    );
  }

  return (
    <SectionPanel title="Metadata">
      <form onSubmit={(e) => void onSubmit(e)} style="display:flex;flex-direction:column;gap:8px">
        <div class="field" style="margin:0">
          <label class="field-label" for="secret-env-name">
            Env var name <span class="req">*</span>
          </label>
          <input
            id="secret-env-name"
            class="input"
            style="font-family:var(--f-mono)"
            value={metaEnvName.value}
            onInput={(e) => {
              metaEnvName.value = (e.currentTarget as HTMLInputElement).value;
            }}
            placeholder="GITHUB_TOKEN"
          />
          <div class="field-help">
            Uppercase POSIX name ([A-Z][A-Z0-9_]*). Renaming takes effect on each member's next
            runner start.
          </div>
        </div>
        <div class="field" style="margin:0">
          <label class="field-label" for="secret-description">
            Description
          </label>
          <input
            id="secret-description"
            class="input"
            value={metaDescription.value}
            onInput={(e) => {
              metaDescription.value = (e.currentTarget as HTMLInputElement).value;
            }}
            placeholder="Read-only PAT for the org's repos"
          />
        </div>
        <div class="flex items-center gap-2">
          <button type="submit" class="btn btn-primary btn-sm" disabled={busy !== null}>
            {busy === 'meta-save' ? 'Saving…' : 'Save metadata'}
          </button>
        </div>
      </form>
    </SectionPanel>
  );
}

function AccessSection({
  secret,
  boundMembers,
}: {
  secret: SecretSummary;
  boundMembers: string[];
}) {
  const b = briefing.value;
  const busy = sectionBusy.value;
  const candidates = (b?.teammates ?? [])
    .map((t) => t.name)
    .filter((name) => !boundMembers.includes(name));

  return (
    <SectionPanel title="Access">
      <label class="flex items-center gap-2" style="cursor:pointer;margin-bottom:12px">
        <input
          type="checkbox"
          class="check"
          checked={secret.allMembers}
          disabled={busy !== null}
          onChange={(e) => {
            const next = (e.currentTarget as HTMLInputElement).checked;
            void run('all-members', () => updateSecret(secret.slug, { allMembers: next }));
          }}
        />
        <span style="font-family:var(--f-sans);font-size:13px;color:var(--ink)">
          Deliver to all members (including future ones)
        </span>
      </label>

      {!secret.allMembers && (
        <>
          {boundMembers.length === 0 && (
            <div style="font-family:var(--f-sans);font-size:13px;color:var(--muted);margin-bottom:10px">
              No members bound — no agent receives this secret yet.
            </div>
          )}
          {boundMembers.length > 0 && (
            <ul class="flex flex-wrap gap-2" style="list-style:none;padding:0;margin:0 0 12px">
              {boundMembers.map((name) => (
                <li key={name} class="chip">
                  {name}
                  <button
                    type="button"
                    class="x"
                    aria-label={`Unbind ${name}`}
                    disabled={busy !== null}
                    onClick={() =>
                      void run(`unbind-${name}`, () => unbindSecret(secret.slug, name))
                    }
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div class="flex items-center gap-2">
            <select
              class="select"
              style="max-width:220px"
              value={bindName.value}
              onChange={(e) => {
                bindName.value = (e.currentTarget as HTMLSelectElement).value;
              }}
              aria-label="Member to bind"
            >
              <option value="">Select member…</option>
              {candidates.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              disabled={busy !== null || bindName.value.length === 0}
              onClick={() =>
                void run('bind', async () => {
                  await bindSecret(secret.slug, bindName.value);
                  bindName.value = '';
                })
              }
            >
              {busy === 'bind' ? 'Binding…' : 'Bind member'}
            </button>
          </div>
        </>
      )}
    </SectionPanel>
  );
}

function ValueSection({ secret }: { secret: SecretSummary }) {
  const busy = sectionBusy.value;

  return (
    <SectionPanel
      title="Value"
      actions={
        secret.hasValue ? (
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            disabled={busy !== null}
            onClick={() => void run('value-rm', () => deleteSecretValue(secret.slug))}
          >
            Remove value
          </button>
        ) : undefined
      }
    >
      <div class="flex items-center gap-2" style="margin-bottom:12px">
        <KeyRound size={14} aria-hidden="true" style="color:var(--muted)" />
        <span style="font-family:var(--f-sans);font-size:13px;color:var(--ink)">
          {secret.hasValue
            ? 'A value is set. It is write-only — replace it below if it rotated.'
            : 'No value set. Nothing is injected until one is added.'}
        </span>
      </div>
      <form
        class="flex items-end gap-2 flex-wrap"
        onSubmit={(e) => {
          e.preventDefault();
          if (valueInput.value.length === 0) {
            sectionError.value = 'Value is required.';
            return;
          }
          void run('value-set', async () => {
            await setSecretValue(secret.slug, valueInput.value);
            valueInput.value = '';
          });
        }}
      >
        <div class="field flex-1" style="margin:0;min-width:200px">
          <label class="field-label" for="secret-value">
            Value
          </label>
          <input
            id="secret-value"
            class="input"
            type="password"
            value={valueInput.value}
            onInput={(e) => {
              valueInput.value = (e.currentTarget as HTMLInputElement).value;
            }}
            placeholder={secret.hasValue ? 'Replace existing value…' : 'Paste value…'}
            autocomplete="off"
          />
        </div>
        <button type="submit" class="btn btn-primary btn-sm" disabled={busy !== null}>
          {busy === 'value-set' ? 'Saving…' : secret.hasValue ? 'Replace' : 'Set value'}
        </button>
      </form>
      <div style="font-family:var(--f-sans);font-size:11.5px;color:var(--muted);font-style:italic;margin-top:8px">
        Delivered as ${secret.envName} on the member's next runner start.
      </div>
    </SectionPanel>
  );
}

function LifecycleSection({ secret }: { secret: SecretSummary }) {
  const busy = sectionBusy.value;
  const confirming = confirmDelete.value;

  return (
    <SectionPanel title="Lifecycle">
      <div class="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          class="btn btn-secondary btn-sm"
          disabled={busy !== null}
          onClick={() =>
            void run('toggle-enabled', () =>
              updateSecret(secret.slug, { enabled: !secret.enabled }),
            )
          }
        >
          {secret.enabled ? 'Disable secret' : 'Enable secret'}
        </button>
        <button
          type="button"
          class="btn btn-destructive btn-sm"
          disabled={busy !== null}
          onClick={() => {
            if (!confirming) {
              confirmDelete.value = true;
              return;
            }
            void run('delete', async () => {
              await deleteSecret(secret.slug);
              selectSecrets();
            });
          }}
        >
          {confirming ? 'Click again to permanently delete' : 'Delete secret'}
        </button>
        {confirming && (
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            onClick={() => {
              confirmDelete.value = false;
            }}
          >
            Keep it
          </button>
        )}
      </div>
      <div style="font-family:var(--f-sans);font-size:11.5px;color:var(--muted);font-style:italic;margin-top:8px">
        Disabling stops delivery on each member's next runner start — already-running agents keep
        their environment. Deleting also removes bindings and the encrypted value.
      </div>
    </SectionPanel>
  );
}

export function __resetSecretDetailForTests(): void {
  sectionError.value = null;
  sectionBusy.value = null;
  detailError.value = null;
  metaEnvName.value = '';
  metaDescription.value = '';
  metaSeededFor.value = null;
  valueInput.value = '';
  bindName.value = '';
  confirmDelete.value = false;
}
