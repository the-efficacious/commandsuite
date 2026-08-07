/**
 * VariableDetail — manage one runner environment variable: metadata,
 * member access, value, and lifecycle.
 *
 * Structurally the twin of `SecretDetail`, sharing its Metadata /
 * Access / Lifecycle sections from `env/shared.tsx`. The value section
 * is the divergence and the whole point of the store: a variable's
 * value is READABLE, so it is rendered rather than hidden, and it is
 * never registered with the trace redactor — which the classification
 * note states in the UI, not just the docs.
 *
 * Three value states, rendered distinctly:
 *   - no value              — nothing is injected
 *   - value present         — shown verbatim, in mono
 *   - set but not readable  — `hasValue` with no `value` in the payload
 *
 * The third only arises for a viewer without `secrets.manage` (who
 * cannot reach this route) or a broker that withheld it. It is still
 * rendered differently from "no value", because rendering both blank
 * is exactly how a configured variable reads as missing — the failure
 * this whole surface exists to stop.
 */

import { SecretEnvNameSchema } from 'csuite-sdk/schemas';
import type { VariableSummary } from 'csuite-sdk/types';
import { hasPermission } from 'csuite-sdk/types';
import { instructions } from '../lib/instructions.js';
import {
  bindVariable,
  deleteVariable,
  deleteVariableValue,
  loadVariableDetail,
  loadVariables,
  setVariableValue,
  unbindVariable,
  updateVariable,
  variableBySlug,
  variableDetails,
  variables,
} from '../lib/variables.js';
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
import { ArrowLeft, Eye } from './icons/index.js';
import { ErrorCallout, Loading } from './ui/index.js';

const ops: EnvOps = {
  update: updateVariable,
  remove: deleteVariable,
  bind: bindVariable,
  unbind: unbindVariable,
};

function validateEnvName(name: string): string | null {
  // The same schema both stores validate against on the server — the
  // env namespace is shared, so the client-side check must be too.
  const validated = SecretEnvNameSchema.safeParse(name);
  if (validated.success) return null;
  return validated.error.issues[0]?.message ?? 'Env var name is invalid.';
}

export function VariableDetail({ slug }: { slug: string }) {
  const b = instructions.value;
  const variable = variableBySlug(slug);

  useEnvDetailReset(slug, async () => {
    if (variables.value === null) void loadVariables();
    await loadVariableDetail(slug);
  });
  useSeedMetadata(slug, variable);

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

  const detail = variableDetails.value[slug] ?? null;

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

      <DetailLoadError kind="variable" />

      {variable === null && detailError.value === null && <Loading label="Loading variable…" />}

      {variable !== null && (
        <>
          <header style="margin-bottom:20px">
            <div class="flex items-center gap-3 flex-wrap">
              <h2
                class="font-display"
                style="margin:0;font-size:26px;font-weight:800;letter-spacing:-0.02em;color:var(--ef-text)"
              >
                {variable.slug}
              </h2>
              <span class="badge">Variable</span>
              <span class={`badge ${variable.enabled ? 'soft' : 'muted'}`}>
                {variable.enabled ? 'Enabled' : 'Disabled'}
              </span>
            </div>
            <div class="fact-grid" style="margin-top:10px">
              <div>
                <div class="fact-k">ENV VAR</div>
                <div class="fact-v">${variable.envName}</div>
              </div>
              <div>
                <div class="fact-k">REGISTERED BY</div>
                <div class="fact-v">{variable.createdBy}</div>
              </div>
            </div>
            {variable.description.length > 0 && (
              <div style="margin-top:8px;font-family:var(--ef-font-body);font-size:12.5px;color:var(--ef-text-muted)">
                {variable.description}
              </div>
            )}
          </header>

          <ClassificationNote kind="variable" />

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
            entry={variable}
            kind="variable"
            ops={ops}
            validateEnvName={validateEnvName}
          />
          <AccessSection
            entry={variable}
            kind="variable"
            ops={ops}
            boundMembers={detail?.boundMembers ?? []}
          />
          <ValueSection variable={variable} />
          <LifecycleSection
            entry={variable}
            kind="variable"
            ops={ops}
            onDeleted={selectEnvironment}
          />
        </>
      )}
    </div>
  );
}

function ValueSection({ variable }: { variable: VariableSummary }) {
  const busy = sectionBusy.value;
  const readable = variable.value !== undefined;

  return (
    <SectionPanel
      title="Value"
      actions={
        variable.hasValue ? (
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            disabled={busy !== null}
            onClick={() => void run('value-rm', () => deleteVariableValue(variable.slug))}
          >
            Remove value
          </button>
        ) : undefined
      }
    >
      {!variable.hasValue && (
        <div class="flex items-center gap-2" style="margin-bottom:12px">
          <Eye size={14} aria-hidden="true" style="color:var(--ef-text-muted)" />
          <span style="font-family:var(--ef-font-body);font-size:13px;color:var(--ef-text)">
            No value set. Nothing is injected until one is added.
          </span>
        </div>
      )}

      {variable.hasValue && readable && (
        <div style="margin-bottom:12px">
          <div class="field-label" style="margin-bottom:4px">
            Current value
          </div>
          <div
            data-testid="variable-value"
            style="font-family:var(--ef-font-mono);font-size:13px;color:var(--ef-text);background:var(--ef-surface-sunken,transparent);border:1px solid var(--ef-border);border-radius:var(--ef-radius-sm);padding:8px 10px;overflow-wrap:anywhere"
          >
            {variable.value}
          </div>
        </div>
      )}

      {variable.hasValue && !readable && (
        <div class="flex items-center gap-2" style="margin-bottom:12px">
          <Eye size={14} aria-hidden="true" style="color:var(--ef-text-muted)" />
          <span style="font-family:var(--ef-font-body);font-size:13px;color:var(--ef-text)">
            A value is set, but it was not returned to this session. It is configured — this is not
            the same as unset.
          </span>
        </div>
      )}

      <form
        class="flex items-end gap-2 flex-wrap"
        onSubmit={(e) => {
          e.preventDefault();
          if (valueInput.value.length === 0) {
            sectionError.value = 'Value is required.';
            return;
          }
          void run('value-set', async () => {
            await setVariableValue(variable.slug, valueInput.value);
            valueInput.value = '';
          });
        }}
      >
        <div class="field flex-1" style="margin:0;min-width:200px">
          <label class="field-label" for="variable-value">
            {variable.hasValue ? 'Replace value' : 'Value'}
          </label>
          <input
            id="variable-value"
            class="input"
            type="text"
            style="font-family:var(--ef-font-mono)"
            value={valueInput.value}
            onInput={(e) => {
              valueInput.value = (e.currentTarget as HTMLInputElement).value;
            }}
            placeholder={variable.hasValue ? 'Replace existing value…' : 'Enter value…'}
            autocomplete="off"
          />
        </div>
        <button type="submit" class="btn btn-primary btn-sm" disabled={busy !== null}>
          {busy === 'value-set' ? 'Saving…' : variable.hasValue ? 'Replace' : 'Set value'}
        </button>
      </form>
      <div style="font-family:var(--ef-font-body);font-size:11.5px;color:var(--ef-text-muted);font-style:italic;margin-top:8px">
        Delivered as ${variable.envName} on the member's next runner start, and left intact in
        captured traces.
      </div>
    </SectionPanel>
  );
}
