/**
 * ToolSourceDetail — manage one tool source: its tool definitions,
 * member access, credential, and lifecycle (enable/disable/delete).
 *
 * Gated on tools.manage like the list panel. Sections are `.panel`s
 * with `.eyebrow` headings; mutations go through lib/tool-sources.ts
 * wrappers (which re-list + re-fetch the detail), and errors surface
 * inline per-section rather than as toasts.
 *
 * The custom tool editor takes the definition as JSON ({ description,
 * inputSchema, binding }) validated client-side with the SDK schema so
 * template typos fail with a path before hitting the server.
 */

import { signal } from '@preact/signals';
import { SetCustomToolRequestSchema } from 'csuite-sdk/schemas';
import type {
  CustomToolDef,
  ResolvedTool,
  SetCustomToolRequest,
  ToolSourceSummary,
} from 'csuite-sdk/types';
import { hasPermission } from 'csuite-sdk/types';
import { useEffect } from 'preact/hooks';
import { briefing } from '../lib/briefing.js';
import {
  bindToolSource,
  deleteCustomTool,
  deleteToolCredential,
  deleteToolSource,
  loadToolSourceDetail,
  loadToolSources,
  refreshToolSource,
  setCustomTool,
  setToolCredential,
  toolSourceBySlug,
  toolSourceDetails,
  toolSources,
  unbindToolSource,
  updateToolSource,
} from '../lib/tool-sources.js';
import { selectToolSources } from '../lib/view.js';
import { KeyRound, RefreshCw, Trash2 } from './icons/index.js';
import { ErrorCallout, Loading } from './ui/index.js';

const sectionError = signal<string | null>(null);
const sectionBusy = signal<string | null>(null);
const detailError = signal<string | null>(null);

const credKind = signal<'bearer' | 'header'>('bearer');
const credHeaderName = signal('');
const credSecret = signal('');

const bindName = signal('');

const toolFormOpen = signal(false);
const toolFormName = signal('');
const toolFormJson = signal('');

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

export function ToolSourceDetail({ slug }: { slug: string }) {
  const b = briefing.value;

  useEffect(() => {
    detailError.value = null;
    confirmDelete.value = false;
    if (toolSources.value === null) void loadToolSources();
    loadToolSourceDetail(slug).catch((err) => {
      detailError.value = err instanceof Error ? err.message : String(err);
    });
  }, [slug]);

  if (!b) return <Loading label="Loading…" />;

  if (!hasPermission(b.permissions, 'tools.manage')) {
    return (
      <div
        class="flex-1 overflow-y-auto"
        style="padding:24px max(1rem,env(safe-area-inset-right)) 24px max(1rem,env(safe-area-inset-left))"
      >
        <ErrorCallout
          title="Restricted"
          message="Managing tool sources requires the tools.manage permission."
        />
      </div>
    );
  }

  const source = toolSourceBySlug(slug);
  const detail = toolSourceDetails.value[slug] ?? null;
  const loadErr = detailError.value;

  return (
    <div
      class="flex-1 overflow-y-auto"
      style="padding:24px max(1rem,env(safe-area-inset-right)) 32px max(1rem,env(safe-area-inset-left))"
    >
      <nav class="crumbs" style="margin-bottom:14px">
        <button type="button" class="text-link" onClick={selectToolSources}>
          ← Tools
        </button>
        <span class="sep">/</span>
        <span class="current">{slug}</span>
      </nav>

      {loadErr !== null && (
        <ErrorCallout
          title="Failed to load tool source"
          message={loadErr}
          style="margin-bottom:18px"
        />
      )}

      {source === null && loadErr === null && <Loading label="Loading source…" />}

      {source !== null && (
        <>
          <header style="margin-bottom:20px">
            <div class="flex items-center gap-3 flex-wrap">
              <h2
                class="font-display"
                style="margin:0;font-size:26px;font-weight:800;letter-spacing:-0.02em;color:var(--ink)"
              >
                {source.slug}
              </h2>
              <span class={`badge ${source.kind === 'mcp' ? 'glacier solid' : 'ember solid'}`}>
                {source.kind === 'mcp' ? 'MCP' : 'Custom'}
              </span>
              <span class={`badge ${source.enabled ? 'soft' : 'muted'}`}>
                {source.enabled ? 'Enabled' : 'Disabled'}
              </span>
            </div>
            <div style="margin-top:6px;font-family:var(--f-mono);font-size:11.5px;color:var(--muted);letter-spacing:.04em">
              {source.displayName.length > 0 ? `${source.displayName} · ` : ''}
              registered by {source.createdBy}
              {source.kind === 'mcp' && source.config.url ? ` · ${source.config.url}` : ''}
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

          <ToolsSection source={source} tools={detail?.tools ?? null} />
          <AccessSection source={source} boundMembers={detail?.boundMembers ?? []} />
          <CredentialSection source={source} />
          <LifecycleSection source={source} />
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

function ToolsSection({
  source,
  tools,
}: {
  source: ToolSourceSummary;
  tools: Array<CustomToolDef | ResolvedTool> | null;
}) {
  const busy = sectionBusy.value;
  const isCustom = source.kind === 'custom';

  return (
    <SectionPanel
      title={`Tools (${source.toolCount})`}
      actions={
        isCustom ? (
          <button
            type="button"
            class="btn btn-secondary btn-sm"
            disabled={busy !== null}
            onClick={() => {
              toolFormOpen.value = !toolFormOpen.value;
              toolFormName.value = '';
              toolFormJson.value = TOOL_JSON_TEMPLATE;
            }}
          >
            + Define tool
          </button>
        ) : (
          <button
            type="button"
            class="btn btn-secondary btn-sm"
            disabled={busy !== null}
            onClick={() => void run('refresh', () => refreshToolSource(source.slug))}
          >
            <RefreshCw size={13} aria-hidden="true" />{' '}
            {busy === 'refresh' ? 'Refreshing…' : 'Refresh from upstream'}
          </button>
        )
      }
    >
      {isCustom && toolFormOpen.value && <DefineToolForm slug={source.slug} />}
      {tools === null && <Loading label="Loading tools…" />}
      {tools !== null && tools.length === 0 && (
        <div style="font-family:var(--f-sans);font-size:13px;color:var(--muted)">
          {isCustom
            ? 'No tools defined yet. Agents see nothing from this source until a tool is defined.'
            : 'No tools discovered yet. Set the credential, then refresh from upstream.'}
        </div>
      )}
      {tools !== null && tools.length > 0 && (
        <ul style="display:flex;flex-direction:column;gap:0;list-style:none;padding:0;margin:0">
          {tools.map((t, idx) => (
            <li
              key={t.name}
              class="flex items-start justify-between gap-3"
              style={`padding:10px 2px;${idx === tools.length - 1 ? '' : 'border-bottom:1px solid var(--rule);'}`}
            >
              <div class="min-w-0">
                <div style="font-family:var(--f-mono);font-size:13px;font-weight:600;color:var(--ink)">
                  {source.slug}__{t.name}
                </div>
                {t.description.length > 0 && (
                  <div style="font-family:var(--f-sans);font-size:12.5px;color:var(--muted);margin-top:2px">
                    {t.description}
                  </div>
                )}
              </div>
              {isCustom && (
                <button
                  type="button"
                  class="btn btn-ghost btn-sm"
                  aria-label={`Delete tool ${t.name}`}
                  disabled={busy !== null}
                  onClick={() =>
                    void run(`del-tool-${t.name}`, () => deleteCustomTool(source.slug, t.name))
                  }
                >
                  <Trash2 size={13} aria-hidden="true" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </SectionPanel>
  );
}

const TOOL_JSON_TEMPLATE = `{
  "description": "Fetch a Jira issue by key.",
  "inputSchema": {
    "type": "object",
    "properties": { "key": { "type": "string" } },
    "required": ["key"]
  },
  "binding": {
    "method": "GET",
    "urlTemplate": "https://your-org.atlassian.net/rest/api/3/issue/{{args.key}}",
    "resultPath": "fields.summary"
  }
}`;

function DefineToolForm({ slug }: { slug: string }) {
  const busy = sectionBusy.value;

  async function onSubmit(e: Event): Promise<void> {
    e.preventDefault();
    const name = toolFormName.value.trim();
    if (!name) {
      sectionError.value = 'Tool name is required.';
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(toolFormJson.value);
    } catch (err) {
      sectionError.value = `Definition is not valid JSON: ${err instanceof Error ? err.message : String(err)}`;
      return;
    }
    const validated = SetCustomToolRequestSchema.safeParse(parsed);
    if (!validated.success) {
      const first = validated.error.issues[0];
      sectionError.value = `Definition invalid at ${first?.path.join('.') || '(root)'}: ${first?.message}`;
      return;
    }
    // Zod's parsed optionals are `T | undefined` which
    // exactOptionalPropertyTypes distinguishes from `prop?: T` — the
    // wire shape is identical, so narrow via the SDK request type.
    const data = validated.data as SetCustomToolRequest;
    await run('define-tool', async () => {
      await setCustomTool(slug, name, data);
      toolFormOpen.value = false;
    });
  }

  return (
    <form
      onSubmit={(e) => void onSubmit(e)}
      style="display:flex;flex-direction:column;gap:8px;margin-bottom:14px;padding-bottom:14px;border-bottom:1px solid var(--rule)"
    >
      <div class="field">
        <label class="field-label" for="tool-name">
          Tool name <span class="req">*</span>
        </label>
        <input
          id="tool-name"
          class="input"
          value={toolFormName.value}
          onInput={(e) => {
            toolFormName.value = (e.currentTarget as HTMLInputElement).value;
          }}
          placeholder="get_issue"
        />
        <div class="field-help">Letters/digits/_/-. Agents see it as {slug}__&lt;name&gt;.</div>
      </div>
      <div class="field">
        <label class="field-label" for="tool-json">
          Definition (JSON) <span class="req">*</span>
        </label>
        <textarea
          id="tool-json"
          class="textarea"
          rows={12}
          style="font-family:var(--f-mono);font-size:12px"
          value={toolFormJson.value}
          onInput={(e) => {
            toolFormJson.value = (e.currentTarget as HTMLTextAreaElement).value;
          }}
        />
        <div class="field-help">
          {'{ description, inputSchema, binding }'} — placeholders use {'{{args.<name>}}'}; the URL
          origin must be static.
        </div>
      </div>
      <div class="flex items-center gap-2">
        <button type="submit" class="btn btn-primary btn-sm" disabled={busy !== null}>
          {busy === 'define-tool' ? 'Saving…' : 'Save tool'}
        </button>
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          onClick={() => {
            toolFormOpen.value = false;
          }}
          disabled={busy !== null}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function AccessSection({
  source,
  boundMembers,
}: {
  source: ToolSourceSummary;
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
          checked={source.allMembers}
          disabled={busy !== null}
          onChange={(e) => {
            const next = (e.currentTarget as HTMLInputElement).checked;
            void run('all-members', () => updateToolSource(source.slug, { allMembers: next }));
          }}
        />
        <span style="font-family:var(--f-sans);font-size:13px;color:var(--ink)">
          Open to all members (including future ones)
        </span>
      </label>

      {!source.allMembers && (
        <>
          {boundMembers.length === 0 && (
            <div style="font-family:var(--f-sans);font-size:13px;color:var(--muted);margin-bottom:10px">
              No members bound — no agent sees these tools yet.
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
                      void run(`unbind-${name}`, () => unbindToolSource(source.slug, name))
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
                  await bindToolSource(source.slug, bindName.value);
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

function CredentialSection({ source }: { source: ToolSourceSummary }) {
  const busy = sectionBusy.value;

  return (
    <SectionPanel
      title="Credential"
      actions={
        source.hasCredential ? (
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            disabled={busy !== null}
            onClick={() => void run('cred-rm', () => deleteToolCredential(source.slug))}
          >
            Remove credential
          </button>
        ) : undefined
      }
    >
      <div class="flex items-center gap-2" style="margin-bottom:12px">
        <KeyRound size={14} aria-hidden="true" style="color:var(--muted)" />
        <span style="font-family:var(--f-sans);font-size:13px;color:var(--ink)">
          {source.hasCredential
            ? 'A credential is set. It is write-only — replace it below if it rotated.'
            : 'No credential set. Requests go out unauthenticated until one is added.'}
        </span>
      </div>
      <form
        class="flex items-end gap-2 flex-wrap"
        onSubmit={(e) => {
          e.preventDefault();
          if (credSecret.value.length === 0) {
            sectionError.value = 'Secret is required.';
            return;
          }
          if (credKind.value === 'header' && credHeaderName.value.trim().length === 0) {
            sectionError.value = 'Header name is required for header credentials.';
            return;
          }
          void run('cred-set', async () => {
            await setToolCredential(source.slug, {
              kind: credKind.value,
              ...(credKind.value === 'header' ? { headerName: credHeaderName.value.trim() } : {}),
              secret: credSecret.value,
            });
            credSecret.value = '';
            credHeaderName.value = '';
          });
        }}
      >
        <div class="field" style="margin:0">
          <label class="field-label" for="cred-kind">
            Kind
          </label>
          <select
            id="cred-kind"
            class="select"
            value={credKind.value}
            onChange={(e) => {
              credKind.value = (e.currentTarget as HTMLSelectElement).value as 'bearer' | 'header';
            }}
          >
            <option value="bearer">Bearer token</option>
            <option value="header">Header</option>
          </select>
        </div>
        {credKind.value === 'header' && (
          <div class="field" style="margin:0">
            <label class="field-label" for="cred-header">
              Header name
            </label>
            <input
              id="cred-header"
              class="input"
              value={credHeaderName.value}
              onInput={(e) => {
                credHeaderName.value = (e.currentTarget as HTMLInputElement).value;
              }}
              placeholder="X-Api-Key"
            />
          </div>
        )}
        <div class="field flex-1" style="margin:0;min-width:200px">
          <label class="field-label" for="cred-secret">
            Secret
          </label>
          <input
            id="cred-secret"
            class="input"
            type="password"
            value={credSecret.value}
            onInput={(e) => {
              credSecret.value = (e.currentTarget as HTMLInputElement).value;
            }}
            placeholder={source.hasCredential ? 'Replace existing secret…' : 'Paste token…'}
            autocomplete="off"
          />
        </div>
        <button type="submit" class="btn btn-primary btn-sm" disabled={busy !== null}>
          {busy === 'cred-set' ? 'Saving…' : source.hasCredential ? 'Replace' : 'Set credential'}
        </button>
      </form>
    </SectionPanel>
  );
}

function LifecycleSection({ source }: { source: ToolSourceSummary }) {
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
              updateToolSource(source.slug, { enabled: !source.enabled }),
            )
          }
        >
          {source.enabled ? 'Disable source' : 'Enable source'}
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
              await deleteToolSource(source.slug);
              selectToolSources();
            });
          }}
        >
          {confirming ? 'Click again to permanently delete' : 'Delete source'}
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
        Disabling hides the tools from bound agents immediately (they're notified live). Deleting
        also removes bindings, the credential, and tool definitions.
      </div>
    </SectionPanel>
  );
}

export function __resetToolSourceDetailForTests(): void {
  sectionError.value = null;
  sectionBusy.value = null;
  detailError.value = null;
  credKind.value = 'bearer';
  credHeaderName.value = '';
  credSecret.value = '';
  bindName.value = '';
  toolFormOpen.value = false;
  toolFormName.value = '';
  toolFormJson.value = '';
  confirmDelete.value = false;
}
