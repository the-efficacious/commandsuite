/**
 * EnvironmentPanel — the secrets.manage-gated registry of everything
 * the runner injects into an agent's environment at spawn.
 *
 * ONE PANEL, TWO STORES, and the reason is the namespace they share.
 * A member can never resolve one env var name from two entries, and
 * the server enforces that ACROSS both stores — so a collision raised
 * while editing a secret names a variable, and vice versa. Two separate
 * panels would surface an error naming a row the panel cannot show.
 * `GET /secrets/resolve` merges them into one env map for the same
 * reason: the runner injects one environment, so one surface describes
 * it.
 *
 * The split still has to be legible, because it is a safety property:
 * a secret's value is scrubbed from captured traces and a variable's is
 * not. So the two live in separate labeled sections rather than one
 * interleaved list with a badge — classification is structural here,
 * not something you can skim past — and creating an entry requires
 * picking a kind, with no default.
 *
 * List signals live in lib/secrets.ts and lib/variables.ts and refresh
 * live on `secret` / `variable` channel events.
 */

import { signal } from '@preact/signals';
import { SecretEnvNameSchema } from 'csuite-sdk/schemas';
import type { SecretSummary, VariableSummary } from 'csuite-sdk/types';
import { hasPermission } from 'csuite-sdk/types';
import { useEffect } from 'preact/hooks';
import { instructions } from '../lib/instructions.js';
import { createSecret, loadSecrets, secrets, secretsError } from '../lib/secrets.js';
import { createVariable, loadVariables, variables, variablesError } from '../lib/variables.js';
import { selectSecretDetail, selectVariableDetail } from '../lib/view.js';
import type { EnvKind } from './env/shared.js';
import { ArrowRight } from './icons/index.js';
import { EmptyState, ErrorCallout, PageHeader } from './ui/index.js';

/** Four row-height shimmer bars standing in for a list while it loads. */
function ListSkeleton() {
  return (
    <div role="status" aria-label="Loading">
      <div class="ef-skeleton" style="height:44px;margin-bottom:8px" />
      <div class="ef-skeleton" style="height:44px;margin-bottom:8px" />
      <div class="ef-skeleton" style="height:44px;margin-bottom:8px" />
      <div class="ef-skeleton" style="height:44px;margin-bottom:8px" />
    </div>
  );
}

const formOpen = signal(false);
/**
 * No default. The kind decides whether the value is scrubbed from
 * traces, and a default is a decision made for someone who did not
 * read the question — which is precisely how a token ends up in the
 * store that publishes it.
 */
const formKind = signal<EnvKind | null>(null);
const formSlug = signal('');
const formEnvName = signal('');
const formDescription = signal('');
const formAllMembers = signal(false);
const formError = signal<string | null>(null);
const formBusy = signal(false);

export function EnvironmentPanel() {
  const b = instructions.value;

  useEffect(() => {
    void loadSecrets();
    void loadVariables();
  }, []);

  if (!b) {
    return (
      <div
        class="flex-1 overflow-y-auto"
        style="padding:24px max(1rem,env(safe-area-inset-right)) 32px max(1rem,env(safe-area-inset-left))"
      >
        <ListSkeleton />
      </div>
    );
  }

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

  const secretList = secrets.value;
  const variableList = variables.value;
  const secretErr = secretsError.value;
  const variableErr = variablesError.value;

  return (
    <div
      class="flex-1 overflow-y-auto"
      style="padding:24px max(1rem,env(safe-area-inset-right)) 32px max(1rem,env(safe-area-inset-left))"
    >
      <PageHeader
        eyebrow="Team"
        title="Environment"
        subtitle="Everything the runner injects into an agent at spawn. Secrets are scrubbed from captured traces; variables are not."
        actions={
          <button
            type="button"
            class="btn btn-primary btn-sm"
            onClick={() => {
              formOpen.value = true;
              formError.value = null;
              formKind.value = null;
              formSlug.value = '';
              formEnvName.value = '';
              formDescription.value = '';
              formAllMembers.value = false;
            }}
            disabled={formBusy.value}
          >
            + New entry
          </button>
        }
      />

      {formOpen.value && <CreateEntryForm />}

      <EnvSection
        kind="secret"
        heading="Secrets"
        blurb="Write-only. The value leaves the broker only into the agent's environment and is scrubbed from captured traces."
        error={secretErr}
        errorTitle="Failed to load secrets"
        emptyTitle="No secrets yet"
        emptyMessage="Register a value that must never appear in a trace with + New entry."
        loaded={secretList !== null}
        rows={
          secretList?.map((s) => (
            <EnvListRow
              key={`secret:${s.slug}`}
              entry={s}
              kind="secret"
              onSelect={() => selectSecretDetail(s.slug)}
            />
          )) ?? []
        }
      />

      <EnvSection
        kind="variable"
        heading="Variables"
        blurb="Readable, and left intact in captured traces. Git identity lives here — a value the team publishes should not be scrubbed from the team's own record."
        error={variableErr}
        errorTitle="Failed to load variables"
        emptyTitle="No variables yet"
        emptyMessage="Register a non-secret value — a git author name, a feature flag — with + New entry."
        loaded={variableList !== null}
        rows={
          variableList?.map((v) => (
            <EnvListRow
              key={`variable:${v.slug}`}
              entry={v}
              kind="variable"
              onSelect={() => selectVariableDetail(v.slug)}
            />
          )) ?? []
        }
      />
    </div>
  );
}

function EnvSection({
  kind,
  heading,
  blurb,
  error,
  errorTitle,
  emptyTitle,
  emptyMessage,
  loaded,
  rows,
}: {
  kind: EnvKind;
  heading: string;
  blurb: string;
  error: string | null;
  errorTitle: string;
  emptyTitle: string;
  emptyMessage: string;
  loaded: boolean;
  rows: preact.ComponentChildren[];
}) {
  return (
    <section style="margin-bottom:28px" aria-label={heading}>
      <div style="margin-bottom:10px">
        <h3
          class="font-display"
          style="margin:0;font-size:17px;font-weight:700;letter-spacing:-0.01em;color:var(--ef-text)"
        >
          {heading}
        </h3>
        <div style="margin-top:3px;font-family:var(--ef-font-body);font-size:12.5px;line-height:1.5;color:var(--ef-text-muted)">
          {blurb}
        </div>
      </div>

      {error !== null && (
        <ErrorCallout title={errorTitle} message={error} style="margin-bottom:12px" />
      )}

      {!loaded && error === null && <ListSkeleton />}

      {loaded && rows.length === 0 && <EmptyState title={emptyTitle} message={emptyMessage} />}

      {loaded && rows.length > 0 && (
        <div class="panel">
          <ul
            style="display:flex;flex-direction:column;list-style:none;padding:0;margin:0"
            data-testid={`${kind}-rows`}
          >
            {rows}
          </ul>
        </div>
      )}
    </section>
  );
}

/**
 * One registry row. The kinds diverge here on purpose: a secret can
 * only ever report WHETHER a value is set, and a variable shows the
 * value itself, because being able to read it back is the capability
 * the store exists to provide.
 */
function EnvListRow({
  entry,
  kind,
  onSelect,
}: {
  entry: SecretSummary | VariableSummary;
  kind: EnvKind;
  onSelect: () => void;
}) {
  const value = kind === 'variable' ? (entry as VariableSummary).value : undefined;
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        class="hover-row w-full flex items-center justify-between gap-3"
        style="padding:14px 16px;border-bottom:1px solid var(--ef-border);background:transparent;text-align:left;cursor:pointer"
        aria-label={`Manage ${kind} ${entry.slug}`}
      >
        <div class="min-w-0 flex items-center gap-3 flex-wrap">
          <span
            class="font-display"
            style="font-weight:700;letter-spacing:-0.01em;font-size:15px;color:var(--ef-text)"
          >
            {entry.slug}
          </span>
          <span style="font-family:var(--ef-font-mono);font-size:11.5px;color:var(--ef-text-muted);letter-spacing:.04em">
            ${entry.envName}
          </span>
          {!entry.enabled && <span class="badge muted">Disabled</span>}
          {entry.allMembers && <span class="badge soft">All members</span>}
          {entry.description.length > 0 && (
            <span style="font-family:var(--ef-font-body);font-size:12.5px;color:var(--ef-text-muted)">
              {entry.description}
            </span>
          )}
        </div>
        <div class="flex items-center gap-3 flex-shrink-0">
          {kind === 'variable' && entry.hasValue && value !== undefined && (
            <span
              data-testid={`variable-row-value-${entry.slug}`}
              style="font-family:var(--ef-font-mono);font-size:12px;color:var(--ef-text);max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
              title={value}
            >
              {value}
            </span>
          )}
          {kind === 'variable' && entry.hasValue && value === undefined && (
            <span
              data-testid={`variable-row-value-${entry.slug}`}
              style="font-family:var(--ef-font-body);font-size:11.5px;color:var(--ef-text-muted);font-style:italic"
            >
              Set, not shown
            </span>
          )}
          {(kind === 'secret' || !entry.hasValue) && (
            <span
              class={`dot ${entry.hasValue ? 'ok' : 'muted'}`}
              title={entry.hasValue ? 'Value set' : 'No value'}
            />
          )}
          <span style="display:inline-flex;align-items:center;gap:4px;font-family:var(--ef-font-mono);font-size:11px;color:var(--ef-text-muted);letter-spacing:.08em;text-transform:uppercase">
            <ArrowRight size={12} aria-hidden="true" />
            Manage
          </span>
        </div>
      </button>
    </li>
  );
}

function KindChoice({
  kind,
  title,
  consequence,
}: {
  kind: EnvKind;
  title: string;
  consequence: string;
}) {
  const selected = formKind.value === kind;
  return (
    <label
      class="flex items-start gap-2"
      style={`cursor:pointer;padding:10px 12px;border-radius:var(--ef-radius-sm);border:1px solid ${
        selected ? 'var(--ef-accent,var(--ef-text))' : 'var(--ef-border)'
      }`}
    >
      <input
        type="radio"
        name="env-kind"
        class="check"
        checked={selected}
        value={kind}
        onChange={() => {
          formKind.value = kind;
          formError.value = null;
        }}
      />
      <span>
        <span style="display:block;font-family:var(--ef-font-body);font-size:13px;font-weight:600;color:var(--ef-text)">
          {title}
        </span>
        <span style="display:block;font-family:var(--ef-font-body);font-size:12px;line-height:1.45;color:var(--ef-text-muted);margin-top:2px">
          {consequence}
        </span>
      </span>
    </label>
  );
}

function CreateEntryForm() {
  const err = formError.value;
  const busy = formBusy.value;
  const kind = formKind.value;

  async function onSubmit(e: Event): Promise<void> {
    e.preventDefault();
    if (kind === null) {
      formError.value = 'Choose whether this is a secret or a variable.';
      return;
    }
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
      const input = {
        slug,
        envName,
        description: formDescription.value.trim(),
        allMembers: formAllMembers.value,
      };
      if (kind === 'secret') {
        await createSecret(input);
        formOpen.value = false;
        selectSecretDetail(slug);
      } else {
        await createVariable(input);
        formOpen.value = false;
        selectVariableDetail(slug);
      }
    } catch (ex) {
      formError.value = ex instanceof Error ? ex.message : String(ex);
    } finally {
      formBusy.value = false;
    }
  }

  return (
    <form class="panel" onSubmit={(e) => void onSubmit(e)} style="padding:16px;margin-bottom:22px">
      <div class="eyebrow" style="margin-bottom:10px">
        New environment entry
      </div>
      {err !== null && <ErrorCallout message={err} style="margin-bottom:10px" />}
      <div style="display:flex;flex-direction:column;gap:10px">
        <fieldset style="border:0;padding:0;margin:0">
          <legend class="field-label" style="padding:0;margin-bottom:6px">
            Kind <span class="req">*</span>
          </legend>
          <div style="display:flex;flex-direction:column;gap:8px">
            <KindChoice
              kind="secret"
              title="Secret"
              consequence="Write-only. Scrubbed from captured traces. For tokens, keys and anything that must not be recorded."
            />
            <KindChoice
              kind="variable"
              title="Variable — not a secret"
              consequence="Readable here, and appears verbatim in captured traces. For git identity, flags and other values the team publishes anyway."
            />
          </div>
        </fieldset>
        <Labeled
          label="Slug"
          hint="Lowercase letters/digits/dashes. Immutable — it names the entry."
        >
          <input
            class="input"
            value={formSlug.value}
            onInput={(e) => {
              formSlug.value = (e.currentTarget as HTMLInputElement).value;
            }}
            placeholder={kind === 'variable' ? 'git-author-name' : 'github-token'}
          />
        </Labeled>
        <Labeled
          label="Env var name"
          hint="Uppercase POSIX name ([A-Z][A-Z0-9_]*) the runner sets on the agent. Reserved names are rejected, and the name must not already reach a bound member from either store."
        >
          <input
            class="input"
            value={formEnvName.value}
            onInput={(e) => {
              formEnvName.value = (e.currentTarget as HTMLInputElement).value;
            }}
            placeholder={kind === 'variable' ? 'GIT_AUTHOR_NAME' : 'GITHUB_TOKEN'}
          />
        </Labeled>
        <Labeled label="Description" hint="Optional purpose note shown alongside the slug">
          <input
            class="input"
            value={formDescription.value}
            onInput={(e) => {
              formDescription.value = (e.currentTarget as HTMLInputElement).value;
            }}
            placeholder={
              kind === 'variable' ? 'Commit author name' : "Read-only PAT for the org's repos"
            }
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
          <span style="font-family:var(--ef-font-body);font-size:13px;color:var(--ef-text)">
            Deliver to all members (skip per-member bindings)
          </span>
        </label>
      </div>
      <div class="flex items-center gap-2" style="margin-top:14px">
        <button type="submit" class="btn btn-primary btn-sm" disabled={busy || kind === null}>
          {busy ? 'Registering…' : kind === null ? 'Choose a kind first' : `Register ${kind}`}
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
      <div class="field-label">{label}</div>
      {children}
      <div class="field-help">{hint}</div>
    </label>
  );
}

export function __resetEnvironmentPanelForTests(): void {
  formOpen.value = false;
  formKind.value = null;
  formSlug.value = '';
  formEnvName.value = '';
  formDescription.value = '';
  formAllMembers.value = false;
  formError.value = null;
  formBusy.value = false;
}
