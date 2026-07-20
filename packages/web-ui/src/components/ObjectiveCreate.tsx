/**
 * New-objective form — visible to admins, operators, and lead-agents.
 * Fields: title, outcome (required), body, assignee (from roster),
 * optional initial watchers.
 *
 * Uses canonical .field / .field-label / .input / .textarea / .select
 * patterns so the form looks identical to forms elsewhere in the
 * brand (component reference, marketing pages).
 */

import { signal } from '@preact/signals';
import type { Attachment } from 'csuite-sdk/types';
import { getClient } from '../lib/client.js';
import { identity } from '../lib/identity.js';
import { createObjective } from '../lib/objectives.js';
import { roster } from '../lib/roster.js';
import { selectObjectiveDetail, selectObjectivesList } from '../lib/view.js';
import { AlertCircle, X } from './icons/index.js';

interface PendingUpload {
  localId: string;
  file: File;
  status: 'uploading' | 'ready' | 'error';
  attachment?: Attachment;
  error?: string;
}

const title = signal('');
const outcome = signal('');
const body = signal('');
const assignee = signal('');
const watchers = signal<string[]>([]);
const attachmentUploads = signal<PendingUpload[]>([]);
const busy = signal(false);
const err = signal<string | null>(null);

let uploadSeq = 0;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function startUpload(file: File, viewer: string): void {
  const entry: PendingUpload = {
    localId: `upload-${++uploadSeq}`,
    file,
    status: 'uploading',
  };
  attachmentUploads.value = [...attachmentUploads.value, entry];
  void (async () => {
    try {
      const result = await getClient().fsWrite({
        path: `/${viewer}/uploads/${file.name}`,
        mimeType: file.type || 'application/octet-stream',
        source: file,
        collision: 'suffix',
      });
      attachmentUploads.value = attachmentUploads.value.map((p) =>
        p.localId === entry.localId
          ? {
              ...p,
              status: 'ready',
              attachment: {
                path: result.entry.path,
                name: result.entry.name,
                size: result.entry.size ?? file.size,
                mimeType: result.entry.mimeType ?? 'application/octet-stream',
              },
            }
          : p,
      );
    } catch (e) {
      attachmentUploads.value = attachmentUploads.value.map((p) =>
        p.localId === entry.localId
          ? { ...p, status: 'error', error: e instanceof Error ? e.message : 'upload failed' }
          : p,
      );
    }
  })();
}

function dismissUpload(localId: string): void {
  attachmentUploads.value = attachmentUploads.value.filter((p) => p.localId !== localId);
}

function resetForm(): void {
  title.value = '';
  outcome.value = '';
  body.value = '';
  assignee.value = '';
  watchers.value = [];
  attachmentUploads.value = [];
  err.value = null;
}

export function ObjectiveCreate() {
  const r = roster.value;
  const teammates = r?.teammates ?? [];
  const id = identity.value;
  const viewer = id?.member ?? '';
  const uploads = attachmentUploads.value;
  const anyUploading = uploads.some((u) => u.status === 'uploading');
  const readyAttachments = uploads
    .filter((u) => u.status === 'ready' && u.attachment)
    .map((u) => u.attachment as Attachment);
  const canSubmit =
    !busy.value &&
    !anyUploading &&
    title.value.trim().length > 0 &&
    outcome.value.trim().length > 0 &&
    assignee.value.length > 0;

  async function onSubmit(e: Event): Promise<void> {
    e.preventDefault();
    if (!canSubmit || busy.value) return;
    busy.value = true;
    err.value = null;
    try {
      const created = await createObjective({
        title: title.value.trim(),
        outcome: outcome.value.trim(),
        assignee: assignee.value,
        ...(body.value.trim() ? { body: body.value.trim() } : {}),
        ...(watchers.value.length > 0 ? { watchers: watchers.value } : {}),
        ...(readyAttachments.length > 0 ? { attachments: readyAttachments } : {}),
      });
      selectObjectiveDetail(created.id);
      resetForm();
    } catch (e2) {
      err.value = e2 instanceof Error ? e2.message : String(e2);
    } finally {
      busy.value = false;
    }
  }

  return (
    <div
      class="flex-1 overflow-y-auto"
      style="padding:20px max(1rem,env(safe-area-inset-right)) 32px max(1rem,env(safe-area-inset-left))"
    >
      <nav aria-label="Breadcrumb" class="crumbs" style="margin-bottom:14px">
        <button type="button" onClick={selectObjectivesList} class="text-link">
          ← Objectives
        </button>
        <span class="sep" aria-hidden="true">
          ›
        </span>
        <span class="current">New</span>
      </nav>
      <div class="eyebrow">New objective</div>
      <h1
        class="font-display"
        style="font-size:30px;font-weight:700;letter-spacing:-0.02em;color:var(--ink);line-height:1.1;margin-top:6px;margin-bottom:24px"
      >
        Create + assign
      </h1>

      <form onSubmit={onSubmit} style="display:flex;flex-direction:column;gap:18px;max-width:680px">
        <div class="field">
          <label class="field-label" for="obj-title">
            Title
          </label>
          <input
            id="obj-title"
            type="text"
            value={title.value}
            onInput={(e) => {
              title.value = (e.currentTarget as HTMLInputElement).value;
            }}
            placeholder="Fix the login redirect bug"
            class="input"
            // biome-ignore lint/a11y/noAutofocus: create-objective is a goal-oriented form; landing focus on the title skips one tab for every user
            autoFocus
          />
        </div>

        <div class="field">
          <label class="field-label" for="obj-outcome">
            Outcome <span class="req">*</span>
          </label>
          <div class="field-help">
            The tangible result that defines "done". Propagates to the assignee's tool descriptions
            and is surfaced when they go to mark complete.
          </div>
          <textarea
            id="obj-outcome"
            rows={3}
            value={outcome.value}
            onInput={(e) => {
              outcome.value = (e.currentTarget as HTMLTextAreaElement).value;
            }}
            placeholder="A user hitting /login while authenticated lands on /dashboard, not /login again."
            class="textarea"
            style="min-height:88px"
          />
        </div>

        <div class="field">
          <label class="field-label" for="obj-body">
            Body (optional)
          </label>
          <textarea
            id="obj-body"
            rows={4}
            value={body.value}
            onInput={(e) => {
              body.value = (e.currentTarget as HTMLTextAreaElement).value;
            }}
            placeholder="Additional context — links, reproductions, constraints."
            class="textarea"
          />
        </div>

        <div class="field">
          <label class="field-label" for="obj-assignee">
            Assignee
          </label>
          <select
            id="obj-assignee"
            value={assignee.value}
            onChange={(e) => {
              assignee.value = (e.currentTarget as HTMLSelectElement).value;
            }}
            class="select"
          >
            <option value="">Select a teammate…</option>
            {teammates.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name} ({t.role.title})
              </option>
            ))}
          </select>
        </div>

        <div class="field">
          <span class="field-label">Initial watchers (optional)</span>
          <div class="field-help">
            Teammates looped into the discussion thread from the start. They'll receive every
            lifecycle event and discussion post without being the assignee. Directors see everything
            automatically; don't add them here.
          </div>
          {watchers.value.length > 0 && (
            <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px">
              {watchers.value.map((w) => (
                <span key={w} class="chip">
                  <span>{w}</span>
                  <button
                    type="button"
                    class="x"
                    aria-label={`Remove watcher ${w}`}
                    style="background:transparent;border:0;padding:0;cursor:pointer"
                    onClick={() => {
                      watchers.value = watchers.value.filter((x) => x !== w);
                    }}
                  >
                    <X size={12} aria-hidden="true" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <select
            value=""
            onChange={(e) => {
              const cs = (e.currentTarget as HTMLSelectElement).value;
              if (!cs) return;
              if (!watchers.value.includes(cs) && cs !== assignee.value) {
                watchers.value = [...watchers.value, cs];
              }
              (e.currentTarget as HTMLSelectElement).value = '';
            }}
            class="select"
            style="margin-top:8px"
          >
            <option value="">Add a watcher…</option>
            {teammates
              .filter((t) => !watchers.value.includes(t.name) && t.name !== assignee.value)
              .map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name} ({t.role.title})
                </option>
              ))}
          </select>
        </div>

        <div class="field">
          <span class="field-label">Attachments (optional)</span>
          <div class="field-help">
            Files you attach here are available to every thread member (originator, assignee,
            watchers, and admins) via the objective's discussion. Files upload into your home under
            /{viewer}/uploads/ and any filename collisions get a numeric suffix.
          </div>
          {uploads.length > 0 && (
            <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px">
              {uploads.map((u) => (
                <span
                  key={u.localId}
                  style={`display:inline-flex;gap:6px;align-items:center;padding:4px 8px;border-radius:4px;font-size:11.5px;background:${u.status === 'error' ? 'rgba(211,47,47,0.1)' : 'var(--bg-alt)'};border:1px solid ${u.status === 'error' ? 'var(--err, #d32f2f)' : 'var(--rule)'}`}
                  title={u.error ?? `${u.file.name} · ${formatSize(u.file.size)}`}
                >
                  <span
                    aria-hidden="true"
                    style={`color:${
                      u.status === 'ready'
                        ? 'var(--ok, #2e7d32)'
                        : u.status === 'error'
                          ? 'var(--err, #d32f2f)'
                          : 'var(--muted)'
                    };font-weight:700`}
                  >
                    {u.status === 'uploading' ? '…' : u.status === 'ready' ? '✓' : '!'}
                  </span>
                  <span style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                    {u.file.name}
                  </span>
                  <span style="color:var(--muted)">{formatSize(u.file.size)}</span>
                  <button
                    type="button"
                    onClick={() => dismissUpload(u.localId)}
                    aria-label={`Remove ${u.file.name}`}
                    style="background:none;border:none;padding:0 0 0 4px;cursor:pointer;color:var(--muted);display:inline-flex;align-items:center"
                  >
                    <X size={12} aria-hidden="true" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <label class="btn" style="margin-top:8px;cursor:pointer;font-size:12px;width:fit-content">
            + Attach files
            <input
              type="file"
              multiple
              hidden
              onChange={(e) => {
                const files = (e.currentTarget as HTMLInputElement).files;
                if (!files || !viewer) return;
                for (const f of Array.from(files)) startUpload(f, viewer);
                (e.currentTarget as HTMLInputElement).value = '';
              }}
            />
          </label>
        </div>

        {err.value && (
          <div role="alert" class="callout err">
            <div class="icon" aria-hidden="true">
              <AlertCircle size={16} />
            </div>
            <div class="body">
              <div class="msg">{err.value}</div>
            </div>
          </div>
        )}

        <div>
          <button type="submit" disabled={!canSubmit} class="btn btn-primary btn-lg">
            {busy.value ? 'Creating…' : anyUploading ? 'Uploading…' : 'Create + assign →'}
          </button>
        </div>
      </form>
    </div>
  );
}

export function __resetObjectiveCreateForTests(): void {
  resetForm();
  busy.value = false;
}
