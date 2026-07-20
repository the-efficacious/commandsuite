/**
 * ToolSourcesPanel — tools.manage-gated registry of platform-defined
 * external tools (custom HTTP bindings + proxied MCP servers).
 *
 * Mirrors MembersPanel: PageHeader with a "+ New source" toggle, an
 * inline create form, and a `.panel` of hover rows linking through to
 * `/tools/:slug`. The list signal lives in lib/tool-sources.ts and
 * refreshes live on `tool_source` channel events.
 */

import { signal } from '@preact/signals';
import type { ToolSourceKind, ToolSourceSummary } from 'csuite-sdk/types';
import { hasPermission } from 'csuite-sdk/types';
import { useEffect } from 'preact/hooks';
import { briefing } from '../lib/briefing.js';
import {
  createToolSource,
  loadToolSources,
  toolSources,
  toolSourcesError,
} from '../lib/tool-sources.js';
import { selectToolSourceDetail } from '../lib/view.js';
import { EmptyState, ErrorCallout, Loading, PageHeader } from './ui/index.js';

const formOpen = signal(false);
const formSlug = signal('');
const formKind = signal<ToolSourceKind>('custom');
const formDisplayName = signal('');
const formUrl = signal('');
const formAllMembers = signal(false);
const formError = signal<string | null>(null);
const formBusy = signal(false);

export function ToolSourcesPanel() {
  const b = briefing.value;

  useEffect(() => {
    void loadToolSources();
  }, []);

  if (!b) return <Loading label="Loading tools…" />;

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

  const list = toolSources.value;
  const err = toolSourcesError.value;

  return (
    <div
      class="flex-1 overflow-y-auto"
      style="padding:24px max(1rem,env(safe-area-inset-right)) 32px max(1rem,env(safe-area-inset-left))"
    >
      <PageHeader
        eyebrow="Team"
        title="Tools"
        subtitle="External tools the platform executes for bound agents — credentials never leave the broker."
        actions={
          <button
            type="button"
            class="btn btn-primary btn-sm"
            onClick={() => {
              formOpen.value = true;
              formError.value = null;
              formSlug.value = '';
              formKind.value = 'custom';
              formDisplayName.value = '';
              formUrl.value = '';
              formAllMembers.value = false;
            }}
            disabled={formBusy.value}
          >
            + New source
          </button>
        }
      />

      {err !== null && (
        <ErrorCallout
          title="Failed to load tool sources"
          message={err}
          style="margin-bottom:18px"
        />
      )}

      {formOpen.value && <CreateSourceForm />}

      {list === null && err === null && <Loading label="Loading…" />}

      {list !== null && list.length === 0 && (
        <EmptyState
          title="No tool sources yet"
          message="Register a custom API binding or a remote MCP server with + New source."
        />
      )}

      {list !== null && list.length > 0 && (
        <div class="panel">
          <ul style="display:flex;flex-direction:column;list-style:none;padding:0;margin:0">
            {list.map((s, idx) => (
              <SourceListRow key={s.slug} source={s} isLast={idx === list.length - 1} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function SourceListRow({ source, isLast }: { source: ToolSourceSummary; isLast: boolean }) {
  const border = isLast ? '' : 'border-bottom:1px solid var(--rule);';
  return (
    <li>
      <button
        type="button"
        onClick={() => selectToolSourceDetail(source.slug)}
        class="hover-row w-full flex items-center justify-between gap-3"
        style={`padding:14px 16px;${border};background:transparent;text-align:left;cursor:pointer`}
        aria-label={`Manage tool source ${source.slug}`}
      >
        <div class="min-w-0 flex items-center gap-3 flex-wrap">
          <span
            class="font-display"
            style="font-weight:700;letter-spacing:-0.01em;font-size:15px;color:var(--ink)"
          >
            {source.slug}
          </span>
          <span class={`badge ${source.kind === 'mcp' ? 'glacier solid' : 'ember solid'}`}>
            {source.kind === 'mcp' ? 'MCP' : 'Custom'}
          </span>
          {!source.enabled && <span class="badge muted">Disabled</span>}
          {source.allMembers && <span class="badge soft">All members</span>}
          {source.displayName.length > 0 && (
            <span style="font-family:var(--f-mono);font-size:11.5px;color:var(--muted);letter-spacing:.04em">
              {source.displayName}
            </span>
          )}
        </div>
        <div class="flex items-center gap-3 flex-shrink-0">
          <span style="font-family:var(--f-mono);font-size:11px;color:var(--muted);letter-spacing:.06em">
            {source.toolCount} tool{source.toolCount === 1 ? '' : 's'}
          </span>
          <span
            class={`dot ${source.hasCredential ? 'ok' : 'muted'}`}
            title={source.hasCredential ? 'Credential set' : 'No credential'}
          />
          <span style="font-family:var(--f-mono);font-size:11px;color:var(--muted);letter-spacing:.08em;text-transform:uppercase">
            → Manage
          </span>
        </div>
      </button>
    </li>
  );
}

function CreateSourceForm() {
  const err = formError.value;
  const busy = formBusy.value;
  const kind = formKind.value;

  async function onSubmit(e: Event): Promise<void> {
    e.preventDefault();
    const slug = formSlug.value.trim();
    if (!slug) {
      formError.value = 'Slug is required.';
      return;
    }
    if (kind === 'mcp' && formUrl.value.trim().length === 0) {
      formError.value = 'MCP sources need an upstream URL.';
      return;
    }
    formBusy.value = true;
    try {
      await createToolSource({
        slug,
        kind,
        displayName: formDisplayName.value.trim(),
        ...(kind === 'mcp' ? { url: formUrl.value.trim() } : {}),
        allMembers: formAllMembers.value,
      });
      formOpen.value = false;
      selectToolSourceDetail(slug);
    } catch (ex) {
      formError.value = ex instanceof Error ? ex.message : String(ex);
    } finally {
      formBusy.value = false;
    }
  }

  return (
    <form class="panel" onSubmit={(e) => void onSubmit(e)} style="padding:16px;margin-bottom:18px">
      <div class="eyebrow" style="margin-bottom:10px">
        New tool source
      </div>
      {err !== null && <ErrorCallout message={err} style="margin-bottom:10px" />}
      <div style="display:flex;flex-direction:column;gap:10px">
        <Labeled
          label="Slug"
          hint="Lowercase letters/digits/dashes. Immutable — it names the tools (slug__tool)."
        >
          <input
            class="input"
            value={formSlug.value}
            onInput={(e) => {
              formSlug.value = (e.currentTarget as HTMLInputElement).value;
            }}
            placeholder="jira"
          />
        </Labeled>
        <Labeled
          label="Kind"
          hint="Custom = HTTP bindings the broker executes. MCP = a remote MCP server the broker proxies."
        >
          <select
            class="select"
            value={kind}
            onChange={(e) => {
              formKind.value = (e.currentTarget as HTMLSelectElement).value as ToolSourceKind;
            }}
          >
            <option value="custom">Custom (HTTP bindings)</option>
            <option value="mcp">MCP (remote server)</option>
          </select>
        </Labeled>
        {kind === 'mcp' && (
          <Labeled
            label="Upstream URL"
            hint="Streamable HTTP endpoint, e.g. https://mcp.example.com/v1"
          >
            <input
              class="input"
              value={formUrl.value}
              onInput={(e) => {
                formUrl.value = (e.currentTarget as HTMLInputElement).value;
              }}
              placeholder="https://…"
            />
          </Labeled>
        )}
        <Labeled label="Display name" hint="Optional mutable label shown alongside the slug">
          <input
            class="input"
            value={formDisplayName.value}
            onInput={(e) => {
              formDisplayName.value = (e.currentTarget as HTMLInputElement).value;
            }}
            placeholder="Jira (service account)"
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
            Open to all members (skip per-member bindings)
          </span>
        </label>
      </div>
      <div class="flex items-center gap-2" style="margin-top:14px">
        <button type="submit" class="btn btn-primary btn-sm" disabled={busy}>
          {busy ? 'Registering…' : 'Register source'}
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

export function __resetToolSourcesPanelForTests(): void {
  formOpen.value = false;
  formSlug.value = '';
  formKind.value = 'custom';
  formDisplayName.value = '';
  formUrl.value = '';
  formAllMembers.value = false;
  formError.value = null;
  formBusy.value = false;
}
