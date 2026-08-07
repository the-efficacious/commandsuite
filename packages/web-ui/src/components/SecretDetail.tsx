/**
 * SecretDetail — manage one secret: its metadata (env var name +
 * description), member access, write-only value, and lifecycle
 * (enable/disable/delete).
 *
 * Gated on secrets.manage like the Environment panel it hangs off.
 * Metadata / Access / Lifecycle come from `env/shared.tsx` and are
 * identical to a variable's; the value section below is the divergence
 * — a secret's value is write-only end to end, so reads only expose
 * `hasValue`, the set/replace input is type=password, and it's cleared
 * on submit.
 *
 * The env var name is validated client-side with the SDK schema so
 * reserved names fail with a message before hitting the server.
 */

import { SecretEnvNameSchema } from 'csuite-sdk/schemas';
import type { SecretSummary } from 'csuite-sdk/types';
import { hasPermission } from 'csuite-sdk/types';
import { instructions } from '../lib/instructions.js';
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
import { selectEnvironment } from '../lib/view.js';
import {
  AccessSection,
  ClassificationNote,
  DetailLoadError,
  detailError,
  type EnvOps,
  LifecycleSection,
  MetadataSection,
  run,
  SectionPanel,
  sectionBusy,
  sectionError,
  useEnvDetailReset,
  useSeedMetadata,
  valueInput,
} from './env/shared.js';
import { ArrowLeft, KeyRound } from './icons/index.js';
import { ErrorCallout, Loading } from './ui/index.js';

const ops: EnvOps = {
  update: updateSecret,
  remove: deleteSecret,
  bind: bindSecret,
  unbind: unbindSecret,
};

function validateEnvName(name: string): string | null {
  const validated = SecretEnvNameSchema.safeParse(name);
  if (validated.success) return null;
  return validated.error.issues[0]?.message ?? 'Env var name is invalid.';
}

export function SecretDetail({ slug }: { slug: string }) {
  const b = instructions.value;
  const secret = secretBySlug(slug);

  useEnvDetailReset(slug, async () => {
    if (secrets.value === null) void loadSecrets();
    await loadSecretDetail(slug);
  });
  useSeedMetadata(slug, secret);

  if (!b) return <Loading label="Loading…" />;

  if (!hasPermission(b.permissions, 'secrets.manage')) {
    return (
      <div
        class="flex-1 overflow-y-auto"
        style="padding:24px max(1rem,env(safe-area-inset-right)) 24px max(1rem,env(safe-area-inset-left))"
      >
        <ErrorCallout
          title="Restricted"
          message="Managing the runner environment requires the secrets.manage permission."
        />
      </div>
    );
  }

  const detail = secretDetails.value[slug] ?? null;

  return (
    <div
      class="flex-1 overflow-y-auto"
      style="padding:24px max(1rem,env(safe-area-inset-right)) 32px max(1rem,env(safe-area-inset-left))"
    >
      <nav class="crumbs" style="margin-bottom:14px">
        <button type="button" class="text-link" onClick={selectEnvironment}>
          <ArrowLeft size={13} aria-hidden="true" />
          Environment
        </button>
        <span class="sep">/</span>
        <span class="current">{slug}</span>
      </nav>

      <DetailLoadError kind="secret" />

      {secret === null && detailError.value === null && <Loading label="Loading secret…" />}

      {secret !== null && (
        <>
          <header style="margin-bottom:20px">
            <div class="flex items-center gap-3 flex-wrap">
              <h2
                class="font-display"
                style="margin:0;font-size:26px;font-weight:800;letter-spacing:-0.02em;color:var(--ef-text)"
              >
                {secret.slug}
              </h2>
              <span class="badge">Secret</span>
              <span class={`badge ${secret.enabled ? 'soft' : 'muted'}`}>
                {secret.enabled ? 'Enabled' : 'Disabled'}
              </span>
            </div>
            <div class="fact-grid" style="margin-top:10px">
              <div>
                <div class="fact-k">ENV VAR</div>
                <div class="fact-v">${secret.envName}</div>
              </div>
              <div>
                <div class="fact-k">REGISTERED BY</div>
                <div class="fact-v">{secret.createdBy}</div>
              </div>
            </div>
            {secret.description.length > 0 && (
              <div style="margin-top:8px;font-family:var(--ef-font-body);font-size:12.5px;color:var(--ef-text-muted)">
                {secret.description}
              </div>
            )}
          </header>

          <ClassificationNote kind="secret" />

          {sectionError.value !== null && (
            <ErrorCallout
              message={sectionError.value}
              style="margin-bottom:16px"
              onDismiss={() => {
                sectionError.value = null;
              }}
            />
          )}

          <MetadataSection
            entry={secret}
            kind="secret"
            ops={ops}
            validateEnvName={validateEnvName}
          />
          <AccessSection
            entry={secret}
            kind="secret"
            ops={ops}
            boundMembers={detail?.boundMembers ?? []}
          />
          <ValueSection secret={secret} />
          <LifecycleSection entry={secret} kind="secret" ops={ops} onDeleted={selectEnvironment} />
        </>
      )}
    </div>
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
        <KeyRound size={14} aria-hidden="true" style="color:var(--ef-text-muted)" />
        <span style="font-family:var(--ef-font-body);font-size:13px;color:var(--ef-text)">
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
      <div style="font-family:var(--ef-font-body);font-size:11.5px;color:var(--ef-text-muted);font-style:italic;margin-top:8px">
        Delivered as ${secret.envName} on the member's next runner start.
      </div>
      {/*
        There is no convert-to-variable action, and the reason is this
        section: the value is write-only, so nothing in this UI — or on
        the API — can read it back to carry it across. Stating that here
        is the difference between an operator who plans for it and one
        who deletes a secret expecting to paste it back.
      */}
      <div style="font-family:var(--ef-font-body);font-size:11.5px;color:var(--ef-text-muted);margin-top:10px;padding-top:10px;border-top:1px solid var(--ef-border)">
        Moving this to a variable means deleting it and registering a new one. The value cannot be
        carried over — it is write-only, so you will need the original to hand.
      </div>
    </SectionPanel>
  );
}
