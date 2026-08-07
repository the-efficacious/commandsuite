/**
 * Shared scaffolding for the two runner-environment detail views.
 *
 * A secret and a variable carry identical metadata — slug, env name,
 * description, enabled, all-members, bindings — and differ only in what
 * may be READ back and what gets redacted from captured traces. So the
 * Metadata, Access and Lifecycle sections are one implementation
 * parameterized by kind, and each detail view owns its own value
 * section: `SecretDetail` renders a write-only input, `VariableDetail`
 * renders the value.
 *
 * Only the noun and a few sentences vary between kinds. That is
 * deliberate — the sections a reader has already learned should not
 * re-teach themselves per store, and the difference that matters
 * (the value) is the one place the two views visibly diverge.
 *
 * The signals here are module-level, matching the convention in the
 * rest of the panel components. One detail view is mounted at a time
 * (the router renders `secret-detail` OR `variable-detail`), so a
 * single set of section signals cannot be contended.
 */

import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { instructions } from '../../lib/instructions.js';
import { ErrorCallout } from '../ui/index.js';

/** Which store an entry lives in. */
export type EnvKind = 'secret' | 'variable';

/**
 * The fields both stores share. `SecretSummary` and `VariableSummary`
 * both satisfy this; nothing here touches a value, so a secret cannot
 * be widened into a shape that carries one.
 */
export interface EnvEntry {
  slug: string;
  envName: string;
  description: string;
  enabled: boolean;
  allMembers: boolean;
  createdBy: string;
  hasValue: boolean;
}

/** The mutation wrappers for one store, from lib/secrets or lib/variables. */
export interface EnvOps {
  update(
    slug: string,
    patch: { envName?: string; description?: string; enabled?: boolean; allMembers?: boolean },
  ): Promise<void>;
  remove(slug: string): Promise<void>;
  bind(slug: string, member: string): Promise<void>;
  unbind(slug: string, member: string): Promise<void>;
}

export const sectionError = signal<string | null>(null);
export const sectionBusy = signal<string | null>(null);
export const detailError = signal<string | null>(null);

export const metaEnvName = signal('');
export const metaDescription = signal('');
// Slug the metadata form was last seeded for — refreshAfterMutation
// re-fetches the summary, and re-seeding then would clobber edits.
export const metaSeededFor = signal<string | null>(null);

export const valueInput = signal('');

export const bindName = signal('');

export const confirmDelete = signal(false);

export async function run(label: string, fn: () => Promise<unknown>): Promise<void> {
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

/** Reset per-slug detail state on navigation. Shared by both views. */
export function useEnvDetailReset(slug: string, load: () => Promise<void>): void {
  useEffect(() => {
    detailError.value = null;
    confirmDelete.value = false;
    metaSeededFor.value = null;
    valueInput.value = '';
    load().catch((err) => {
      detailError.value = err instanceof Error ? err.message : String(err);
    });
  }, [slug]);
}

/** Seed the metadata form once per slug, after the summary loads. */
export function useSeedMetadata(slug: string, entry: EnvEntry | null): void {
  useEffect(() => {
    if (entry !== null && metaSeededFor.value !== slug) {
      metaEnvName.value = entry.envName;
      metaDescription.value = entry.description;
      metaSeededFor.value = slug;
    }
  }, [slug, entry]);
}

export function SectionPanel({
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

/**
 * The one-line statement of what this kind does to a captured trace.
 * Rendered on both detail views and above both list sections, because
 * the panel is where someone will paste a token into the wrong store
 * and the classification has to be legible at that moment — not only
 * in the docs.
 */
export function ClassificationNote({ kind }: { kind: EnvKind }) {
  const secret = kind === 'secret';
  return (
    <div class={`env-note ${secret ? 'nominal' : 'caution'}`}>
      <span>
        {secret ? (
          <>
            <strong class="env-note-lead">Secret.</strong> The value is write-only — it leaves the
            broker only into the agent's environment, and it is scrubbed from captured traces.
          </>
        ) : (
          <>
            <strong class="env-note-lead">Variable — not a secret.</strong> The value is readable
            here and <strong>appears verbatim in captured traces</strong>. Use a secret for anything
            that must not be recorded.
          </>
        )}
      </span>
    </div>
  );
}

export function MetadataSection({
  entry,
  kind,
  ops,
  validateEnvName,
}: {
  entry: EnvEntry;
  kind: EnvKind;
  ops: EnvOps;
  validateEnvName: (name: string) => string | null;
}) {
  const busy = sectionBusy.value;

  async function onSubmit(e: Event): Promise<void> {
    e.preventDefault();
    const envName = metaEnvName.value.trim();
    const invalid = validateEnvName(envName);
    if (invalid !== null) {
      sectionError.value = invalid;
      return;
    }
    await run('meta-save', () =>
      ops.update(entry.slug, { envName, description: metaDescription.value.trim() }),
    );
  }

  return (
    <SectionPanel title="Metadata">
      <form onSubmit={(e) => void onSubmit(e)} style="display:flex;flex-direction:column;gap:8px">
        <div class="field" style="margin:0">
          <label class="field-label" for="env-name">
            Env var name <span class="req">*</span>
          </label>
          <input
            id="env-name"
            class="input env-w-key"
            style="font-family:var(--ef-font-mono)"
            value={metaEnvName.value}
            onInput={(e) => {
              metaEnvName.value = (e.currentTarget as HTMLInputElement).value;
            }}
            placeholder={kind === 'secret' ? 'GITHUB_TOKEN' : 'GIT_AUTHOR_NAME'}
          />
          <div class="field-help env-prose">
            Uppercase POSIX name ([A-Z][A-Z0-9_]*). Renaming takes effect on each member's next
            runner start. A member can never resolve one name from two entries — secrets and
            variables share the namespace.
          </div>
        </div>
        <div class="field" style="margin:0">
          <label class="field-label" for="env-description">
            Description
          </label>
          <input
            id="env-description"
            class="input env-w-prose"
            value={metaDescription.value}
            onInput={(e) => {
              metaDescription.value = (e.currentTarget as HTMLInputElement).value;
            }}
            placeholder={
              kind === 'secret' ? "Read-only PAT for the org's repos" : 'Commit author name'
            }
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

export function AccessSection({
  entry,
  kind,
  ops,
  boundMembers,
}: {
  entry: EnvEntry;
  kind: EnvKind;
  ops: EnvOps;
  boundMembers: string[];
}) {
  const b = instructions.value;
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
          checked={entry.allMembers}
          disabled={busy !== null}
          onChange={(e) => {
            const next = (e.currentTarget as HTMLInputElement).checked;
            void run('all-members', () => ops.update(entry.slug, { allMembers: next }));
          }}
        />
        <span style="font-family:var(--ef-font-body);font-size:13px;color:var(--ef-text)">
          Deliver to all members (including future ones)
        </span>
      </label>

      {!entry.allMembers && (
        <>
          {boundMembers.length === 0 && (
            <div
              class="env-prose"
              style="font-family:var(--ef-font-body);font-size:13px;color:var(--ef-text-muted);margin-bottom:10px"
            >
              No members bound — no agent receives this {kind} yet.
            </div>
          )}
          {boundMembers.length > 0 && (
            <ul class="flex flex-wrap gap-2" style="list-style:none;padding:0;margin:0 0 12px">
              {boundMembers.map((name) => (
                <li key={name} class="token">
                  {name}
                  <button
                    type="button"
                    class="x"
                    aria-label={`Unbind ${name}`}
                    disabled={busy !== null}
                    onClick={() => void run(`unbind-${name}`, () => ops.unbind(entry.slug, name))}
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
                  await ops.bind(entry.slug, bindName.value);
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

export function LifecycleSection({
  entry,
  kind,
  ops,
  onDeleted,
}: {
  entry: EnvEntry;
  kind: EnvKind;
  ops: EnvOps;
  onDeleted: () => void;
}) {
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
            void run('toggle-enabled', () => ops.update(entry.slug, { enabled: !entry.enabled }))
          }
        >
          {entry.enabled ? `Disable ${kind}` : `Enable ${kind}`}
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
              await ops.remove(entry.slug);
              onDeleted();
            });
          }}
        >
          {confirming ? 'Click again to permanently delete' : `Delete ${kind}`}
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
      <div class="env-hint">
        Disabling stops delivery on each member's next runner start — already-running agents keep
        their environment. Deleting also removes bindings and the{' '}
        {kind === 'secret' ? 'encrypted' : 'stored'} value.
      </div>
    </SectionPanel>
  );
}

export function DetailLoadError({ kind }: { kind: EnvKind }) {
  const loadErr = detailError.value;
  if (loadErr === null) return null;
  return (
    <ErrorCallout title={`Failed to load ${kind}`} message={loadErr} style="margin-bottom:18px" />
  );
}

/** Test-only reset so unit tests start clean. */
export function __resetEnvDetailForTests(): void {
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
