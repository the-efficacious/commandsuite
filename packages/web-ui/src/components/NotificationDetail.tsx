/**
 * NotificationDetail — manage one External Notification endpoint:
 * metadata (label / level / template / dedupe), targets, the
 * verification config + write-only signing secret, the delivery
 * policy (offline queue / busy wait / debounce), the delivery
 * receipts (with per-row replay), and lifecycle
 * (enable/disable/delete).
 *
 * Gated on notifications.manage like the list panel. Sections are
 * `.panel`s with `.eyebrow` headings; mutations go through
 * lib/notifications.ts wrappers (which re-list), and errors surface
 * inline per-section rather than as toasts.
 *
 * The signing secret is write-only end to end: reads only expose
 * `hasSecret`, the set/replace input is type=password, and it's
 * cleared on submit.
 */

import { signal } from '@preact/signals';
import type {
  NotificationAuthKind,
  NotificationDelivery,
  NotificationDeliveryStatus,
  NotificationEndpointSummary,
} from 'csuite-sdk/types';
import { hasPermission } from 'csuite-sdk/types';
import { useEffect } from 'preact/hooks';
import { briefing } from '../lib/briefing.js';
import {
  deleteNotificationEndpoint,
  deleteNotificationEndpointSecret,
  loadNotificationDeliveries,
  loadNotificationEndpoints,
  loadNotificationProfiles,
  notificationDeliveries,
  notificationEndpointBySlug,
  notificationEndpoints,
  notificationProfiles,
  replayNotificationDelivery,
  setNotificationEndpointSecret,
  updateNotificationEndpoint,
} from '../lib/notifications.js';
import { selectNotifications } from '../lib/view.js';
import { KeyRound } from './icons/index.js';
import { describeTarget, parseTargetsInput } from './NotificationsPanel.js';
import { ErrorCallout, Loading } from './ui/index.js';

const sectionError = signal<string | null>(null);
const sectionBusy = signal<string | null>(null);
const detailError = signal<string | null>(null);

const metaDisplayName = signal('');
const metaDescription = signal('');
const metaLevel = signal('info');
const metaTitle = signal('');
const metaTemplate = signal('');
const metaDedupeHeader = signal('');
// Slug the forms were last seeded for — a post-mutation re-list
// would otherwise clobber in-progress edits.
const seededFor = signal<string | null>(null);

const targetsInput = signal('');

const authKind = signal<NotificationAuthKind>('hmac-sha256');
const authHeader = signal('');
const authPrefix = signal('');
const authProfile = signal('');
const secretInput = signal('');

const policyIfOffline = signal<'drop' | 'queue'>('drop');
const policyIfBusy = signal<'now' | 'wait'>('now');
const policyDebounceMs = signal('0');
const policyDebounceMax = signal('20');

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

export function NotificationDetail({ slug }: { slug: string }) {
  const b = briefing.value;
  const endpoint = notificationEndpointBySlug(slug);

  useEffect(() => {
    detailError.value = null;
    confirmDelete.value = false;
    seededFor.value = null;
    secretInput.value = '';
    if (notificationEndpoints.value === null) void loadNotificationEndpoints();
    loadNotificationProfiles().catch(() => {
      /* profile select degrades to inline-auth only */
    });
    loadNotificationDeliveries(slug).catch((err) => {
      detailError.value = err instanceof Error ? err.message : String(err);
    });
  }, [slug]);

  // Seed the edit forms once per slug, after the summary loads.
  useEffect(() => {
    if (endpoint !== null && seededFor.value !== slug) {
      metaDisplayName.value = endpoint.displayName;
      metaDescription.value = endpoint.description;
      metaLevel.value = endpoint.level;
      metaTitle.value = endpoint.title ?? '';
      metaTemplate.value = endpoint.template ?? '';
      metaDedupeHeader.value = endpoint.dedupeHeader ?? '';
      targetsInput.value = endpoint.targets.map(describeTarget).join(' ');
      authKind.value = endpoint.auth.kind;
      authHeader.value = endpoint.auth.headerName ?? '';
      authPrefix.value = endpoint.auth.prefix ?? '';
      authProfile.value = endpoint.authProfile ?? '';
      policyIfOffline.value = endpoint.policy.ifOffline;
      policyIfBusy.value = endpoint.policy.ifBusy;
      policyDebounceMs.value = String(endpoint.policy.debounceMs);
      policyDebounceMax.value = String(endpoint.policy.debounceMax);
      seededFor.value = slug;
    }
  }, [slug, endpoint]);

  if (!b) return <Loading label="Loading…" />;

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

  const loadErr = detailError.value;

  return (
    <div
      class="flex-1 overflow-y-auto"
      style="padding:24px max(1rem,env(safe-area-inset-right)) 32px max(1rem,env(safe-area-inset-left))"
    >
      <nav class="crumbs" style="margin-bottom:14px">
        <button type="button" class="text-link" onClick={selectNotifications}>
          ← Notifications
        </button>
        <span class="sep">/</span>
        <span class="current">{slug}</span>
      </nav>

      {loadErr !== null && (
        <ErrorCallout
          title="Failed to load endpoint"
          message={loadErr}
          style="margin-bottom:18px"
        />
      )}

      {endpoint === null && loadErr === null && <Loading label="Loading endpoint…" />}

      {endpoint !== null && (
        <>
          <header style="margin-bottom:20px">
            <div class="flex items-center gap-3 flex-wrap">
              <h2
                class="font-display"
                style="margin:0;font-size:26px;font-weight:800;letter-spacing:-0.02em;color:var(--ink)"
              >
                {endpoint.slug}
              </h2>
              <span class={`badge ${endpoint.enabled ? 'soft' : 'muted'}`}>
                {endpoint.enabled ? 'Enabled' : 'Disabled'}
              </span>
            </div>
            <div style="margin-top:6px;font-family:var(--f-mono);font-size:11.5px;color:var(--muted);letter-spacing:.04em">
              POST /hooks/{endpoint.slug} · registered by {endpoint.createdBy}
              {endpoint.description.length > 0 ? ` · ${endpoint.description}` : ''}
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

          <TargetsSection endpoint={endpoint} />
          <VerificationSection endpoint={endpoint} />
          <PolicySection endpoint={endpoint} />
          <MetadataSection endpoint={endpoint} />
          <DeliveriesSection endpoint={endpoint} />
          <LifecycleSection endpoint={endpoint} />
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

function TargetsSection({ endpoint }: { endpoint: NotificationEndpointSummary }) {
  const busy = sectionBusy.value;

  return (
    <SectionPanel title="Targets">
      <form
        class="flex items-end gap-2 flex-wrap"
        onSubmit={(e) => {
          e.preventDefault();
          const targets = parseTargetsInput(targetsInput.value);
          if (targets.length === 0) {
            sectionError.value = 'At least one target is required (@member or #channel).';
            return;
          }
          void run('targets-save', () => updateNotificationEndpoint(endpoint.slug, { targets }));
        }}
      >
        <div class="field flex-1" style="margin:0;min-width:220px">
          <label class="field-label" for="endpoint-targets">
            Targets <span class="req">*</span>
          </label>
          <input
            id="endpoint-targets"
            class="input"
            style="font-family:var(--f-mono)"
            value={targetsInput.value}
            onInput={(e) => {
              targetsInput.value = (e.currentTarget as HTMLInputElement).value;
            }}
            placeholder="@builder #ops"
          />
          <div class="field-help">
            Space-separated. @member delivers a DM copy per member; #channel posts to channel
            members. Channel slugs are resolved to stable ids at save.
          </div>
        </div>
        <button type="submit" class="btn btn-primary btn-sm" disabled={busy !== null}>
          {busy === 'targets-save' ? 'Saving…' : 'Save targets'}
        </button>
      </form>
    </SectionPanel>
  );
}

function VerificationSection({ endpoint }: { endpoint: NotificationEndpointSummary }) {
  const busy = sectionBusy.value;
  const profiles = notificationProfiles.value ?? [];
  const usingProfile = authProfile.value.length > 0;

  return (
    <SectionPanel title="Verification">
      <form
        style="display:flex;flex-direction:column;gap:10px;margin-bottom:14px"
        onSubmit={(e) => {
          e.preventDefault();
          void run('auth-save', () =>
            updateNotificationEndpoint(endpoint.slug, {
              authProfile: authProfile.value.length > 0 ? authProfile.value : null,
              auth: {
                kind: authKind.value,
                headerName: authHeader.value.trim().length > 0 ? authHeader.value.trim() : null,
                prefix: authPrefix.value.length > 0 ? authPrefix.value : null,
              },
            }),
          );
        }}
      >
        <div class="flex items-end gap-2 flex-wrap">
          <div class="field" style="margin:0">
            <label class="field-label" for="endpoint-auth-profile">
              Auth profile
            </label>
            <select
              id="endpoint-auth-profile"
              class="select"
              value={authProfile.value}
              onChange={(e) => {
                authProfile.value = (e.currentTarget as HTMLSelectElement).value;
              }}
            >
              <option value="">(inline — this endpoint's own secret)</option>
              {profiles.map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.slug} ({p.auth.kind}
                  {p.hasSecret ? '' : ', no secret'})
                </option>
              ))}
            </select>
          </div>
          {!usingProfile && (
            <>
              <div class="field" style="margin:0">
                <label class="field-label" for="endpoint-auth-kind">
                  Scheme
                </label>
                <select
                  id="endpoint-auth-kind"
                  class="select"
                  value={authKind.value}
                  onChange={(e) => {
                    authKind.value = (e.currentTarget as HTMLSelectElement)
                      .value as NotificationAuthKind;
                  }}
                >
                  <option value="hmac-sha256">HMAC-SHA256</option>
                  <option value="header-secret">Shared-secret header</option>
                </select>
              </div>
              <div class="field" style="margin:0">
                <label class="field-label" for="endpoint-auth-header">
                  Header
                </label>
                <input
                  id="endpoint-auth-header"
                  class="input"
                  style="font-family:var(--f-mono);max-width:220px"
                  value={authHeader.value}
                  onInput={(e) => {
                    authHeader.value = (e.currentTarget as HTMLInputElement).value;
                  }}
                  placeholder={
                    authKind.value === 'hmac-sha256' ? 'x-hub-signature-256' : 'x-hook-secret'
                  }
                />
              </div>
              {authKind.value === 'hmac-sha256' && (
                <div class="field" style="margin:0">
                  <label class="field-label" for="endpoint-auth-prefix">
                    Value prefix
                  </label>
                  <input
                    id="endpoint-auth-prefix"
                    class="input"
                    style="font-family:var(--f-mono);max-width:130px"
                    value={authPrefix.value}
                    onInput={(e) => {
                      authPrefix.value = (e.currentTarget as HTMLInputElement).value;
                    }}
                    placeholder="sha256="
                  />
                </div>
              )}
            </>
          )}
          <button type="submit" class="btn btn-primary btn-sm" disabled={busy !== null}>
            {busy === 'auth-save' ? 'Saving…' : 'Save verification'}
          </button>
        </div>
        <div class="field-help" style="margin:0">
          Empty header/prefix fall back to the scheme defaults (GitHub-compatible for HMAC).
          Verification fails closed: without a secret the endpoint rejects every request.
        </div>
      </form>

      {!usingProfile && (
        <>
          <div class="flex items-center gap-2" style="margin-bottom:10px">
            <KeyRound size={14} aria-hidden="true" style="color:var(--muted)" />
            <span style="font-family:var(--f-sans);font-size:13px;color:var(--ink)">
              {endpoint.hasSecret
                ? 'A signing secret is set. It is write-only — replace it below if the sender rotated.'
                : 'No signing secret set. The endpoint rejects everything until one is added.'}
            </span>
            {endpoint.hasSecret && (
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                disabled={busy !== null}
                onClick={() =>
                  void run('secret-rm', () => deleteNotificationEndpointSecret(endpoint.slug))
                }
              >
                Remove secret
              </button>
            )}
          </div>
          <form
            class="flex items-end gap-2 flex-wrap"
            onSubmit={(e) => {
              e.preventDefault();
              if (secretInput.value.length === 0) {
                sectionError.value = 'Secret is required.';
                return;
              }
              void run('secret-set', async () => {
                await setNotificationEndpointSecret(endpoint.slug, secretInput.value);
                secretInput.value = '';
              });
            }}
          >
            <div class="field flex-1" style="margin:0;min-width:200px">
              <label class="field-label" for="endpoint-secret">
                Signing secret
              </label>
              <input
                id="endpoint-secret"
                class="input"
                type="password"
                value={secretInput.value}
                onInput={(e) => {
                  secretInput.value = (e.currentTarget as HTMLInputElement).value;
                }}
                placeholder={endpoint.hasSecret ? 'Replace existing secret…' : 'Paste secret…'}
                autocomplete="off"
              />
            </div>
            <button type="submit" class="btn btn-primary btn-sm" disabled={busy !== null}>
              {busy === 'secret-set' ? 'Saving…' : endpoint.hasSecret ? 'Replace' : 'Set secret'}
            </button>
          </form>
        </>
      )}
    </SectionPanel>
  );
}

function PolicySection({ endpoint }: { endpoint: NotificationEndpointSummary }) {
  const busy = sectionBusy.value;

  return (
    <SectionPanel title="Delivery policy">
      <form
        class="flex items-end gap-3 flex-wrap"
        onSubmit={(e) => {
          e.preventDefault();
          const debounceMs = Number(policyDebounceMs.value);
          const debounceMax = Number(policyDebounceMax.value);
          if (!Number.isInteger(debounceMs) || debounceMs < 0) {
            sectionError.value = 'Debounce window must be a non-negative integer (ms).';
            return;
          }
          void run('policy-save', () =>
            updateNotificationEndpoint(endpoint.slug, {
              policy: {
                ifOffline: policyIfOffline.value,
                ifBusy: policyIfBusy.value,
                debounceMs,
                ...(Number.isInteger(debounceMax) && debounceMax >= 2 ? { debounceMax } : {}),
              },
            }),
          );
        }}
      >
        <div class="field" style="margin:0">
          <label class="field-label" for="policy-if-offline">
            Target offline
          </label>
          <select
            id="policy-if-offline"
            class="select"
            value={policyIfOffline.value}
            onChange={(e) => {
              policyIfOffline.value = (e.currentTarget as HTMLSelectElement).value as
                | 'drop'
                | 'queue';
            }}
          >
            <option value="drop">Drop (default)</option>
            <option value="queue">Queue until wake</option>
          </select>
        </div>
        <div class="field" style="margin:0">
          <label class="field-label" for="policy-if-busy">
            Target mid-task
          </label>
          <select
            id="policy-if-busy"
            class="select"
            value={policyIfBusy.value}
            onChange={(e) => {
              policyIfBusy.value = (e.currentTarget as HTMLSelectElement).value as 'now' | 'wait';
            }}
          >
            <option value="now">Deliver now (default)</option>
            <option value="wait">Wait for idle</option>
          </select>
        </div>
        <div class="field" style="margin:0">
          <label class="field-label" for="policy-debounce-ms">
            Debounce (ms)
          </label>
          <input
            id="policy-debounce-ms"
            class="input"
            style="max-width:110px;font-family:var(--f-mono)"
            inputMode="numeric"
            value={policyDebounceMs.value}
            onInput={(e) => {
              policyDebounceMs.value = (e.currentTarget as HTMLInputElement).value;
            }}
          />
        </div>
        <div class="field" style="margin:0">
          <label class="field-label" for="policy-debounce-max">
            Burst cap
          </label>
          <input
            id="policy-debounce-max"
            class="input"
            style="max-width:90px;font-family:var(--f-mono)"
            inputMode="numeric"
            value={policyDebounceMax.value}
            onInput={(e) => {
              policyDebounceMax.value = (e.currentTarget as HTMLInputElement).value;
            }}
          />
        </div>
        <button type="submit" class="btn btn-primary btn-sm" disabled={busy !== null}>
          {busy === 'policy-save' ? 'Saving…' : 'Save policy'}
        </button>
      </form>
      <div style="font-family:var(--f-sans);font-size:11.5px;color:var(--muted);font-style:italic;margin-top:8px">
        Senders can override per delivery with ?if_offline= / ?if_busy= / ?level= on the hook URL;
        level=critical always punches through debounce and busy-wait. Queued deliveries expire after{' '}
        {Math.round(endpoint.policy.queueTtlMs / 3_600_000)}h; busy-waits force-deliver after{' '}
        {Math.round(endpoint.policy.maxWaitMs / 60_000)}m.
      </div>
    </SectionPanel>
  );
}

function MetadataSection({ endpoint }: { endpoint: NotificationEndpointSummary }) {
  const busy = sectionBusy.value;

  return (
    <SectionPanel title="Message shaping">
      <form
        style="display:flex;flex-direction:column;gap:8px"
        onSubmit={(e) => {
          e.preventDefault();
          void run('meta-save', () =>
            updateNotificationEndpoint(endpoint.slug, {
              displayName: metaDisplayName.value.trim(),
              description: metaDescription.value.trim(),
              level: metaLevel.value as NotificationEndpointSummary['level'],
              title: metaTitle.value.trim().length > 0 ? metaTitle.value.trim() : null,
              template: metaTemplate.value.length > 0 ? metaTemplate.value : null,
              dedupeHeader:
                metaDedupeHeader.value.trim().length > 0 ? metaDedupeHeader.value.trim() : null,
            }),
          );
        }}
      >
        <div class="flex items-end gap-2 flex-wrap">
          <div class="field" style="margin:0">
            <label class="field-label" for="endpoint-display-name">
              Display name
            </label>
            <input
              id="endpoint-display-name"
              class="input"
              value={metaDisplayName.value}
              onInput={(e) => {
                metaDisplayName.value = (e.currentTarget as HTMLInputElement).value;
              }}
              placeholder="CI Alerts"
            />
          </div>
          <div class="field" style="margin:0">
            <label class="field-label" for="endpoint-level">
              Level
            </label>
            <select
              id="endpoint-level"
              class="select"
              value={metaLevel.value}
              onChange={(e) => {
                metaLevel.value = (e.currentTarget as HTMLSelectElement).value;
              }}
            >
              {['debug', 'info', 'notice', 'warning', 'error', 'critical'].map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          <div class="field" style="margin:0">
            <label class="field-label" for="endpoint-dedupe">
              Dedupe header
            </label>
            <input
              id="endpoint-dedupe"
              class="input"
              style="font-family:var(--f-mono);max-width:220px"
              value={metaDedupeHeader.value}
              onInput={(e) => {
                metaDedupeHeader.value = (e.currentTarget as HTMLInputElement).value;
              }}
              placeholder="x-github-delivery"
            />
          </div>
        </div>
        <div class="field" style="margin:0">
          <label class="field-label" for="endpoint-description">
            Description
          </label>
          <input
            id="endpoint-description"
            class="input"
            value={metaDescription.value}
            onInput={(e) => {
              metaDescription.value = (e.currentTarget as HTMLInputElement).value;
            }}
          />
        </div>
        <div class="field" style="margin:0">
          <label class="field-label" for="endpoint-template">
            Body template
          </label>
          <textarea
            id="endpoint-template"
            class="textarea"
            style="font-family:var(--f-mono);min-height:64px"
            value={metaTemplate.value}
            onInput={(e) => {
              metaTemplate.value = (e.currentTarget as HTMLTextAreaElement).value;
            }}
            placeholder={'CI {{payload.state}} on {{payload.branches.0}}'}
          />
          <div class="field-help">
            {
              '{{payload.<dot.path>}} substitution over the JSON payload. Empty = pretty-printed payload. Templates shape only the fenced content — the provenance wrap is not configurable.'
            }
          </div>
        </div>
        <div class="flex items-center gap-2">
          <button type="submit" class="btn btn-primary btn-sm" disabled={busy !== null}>
            {busy === 'meta-save' ? 'Saving…' : 'Save shaping'}
          </button>
        </div>
      </form>
    </SectionPanel>
  );
}

const STATUS_BADGE: Record<NotificationDeliveryStatus, string> = {
  delivered: 'badge soft',
  pending: 'badge muted',
  expired: 'badge muted',
  dropped: 'badge muted',
  rejected: 'badge ember solid',
  filtered: 'badge muted',
  duplicate: 'badge muted',
  coalesced: 'badge soft',
  failed: 'badge ember solid',
};

function DeliveriesSection({ endpoint }: { endpoint: NotificationEndpointSummary }) {
  const busy = sectionBusy.value;
  const deliveries = notificationDeliveries.value[endpoint.slug] ?? null;

  return (
    <SectionPanel
      title="Deliveries"
      actions={
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          disabled={busy !== null}
          onClick={() =>
            void run('deliveries-refresh', () => loadNotificationDeliveries(endpoint.slug))
          }
        >
          {busy === 'deliveries-refresh' ? 'Refreshing…' : 'Refresh'}
        </button>
      }
    >
      {deliveries === null && (
        <div style="font-family:var(--f-sans);font-size:13px;color:var(--muted)">Loading…</div>
      )}
      {deliveries !== null && deliveries.length === 0 && (
        <div style="font-family:var(--f-sans);font-size:13px;color:var(--muted)">
          No deliveries yet. Point the sender at POST /hooks/{endpoint.slug} — every request lands a
          receipt here, including rejected ones.
        </div>
      )}
      {deliveries !== null && deliveries.length > 0 && (
        <ul style="display:flex;flex-direction:column;gap:8px;list-style:none;padding:0;margin:0">
          {deliveries.map((d) => (
            <DeliveryRow key={d.id} endpoint={endpoint} delivery={d} />
          ))}
        </ul>
      )}
    </SectionPanel>
  );
}

function DeliveryRow({
  endpoint,
  delivery,
}: {
  endpoint: NotificationEndpointSummary;
  delivery: NotificationDelivery;
}) {
  const busy = sectionBusy.value;
  const when = new Date(delivery.receivedAt).toLocaleString();
  return (
    <li
      class="flex flex-col gap-1"
      style="border:1px solid var(--rule);border-radius:var(--r-xs);padding:10px 12px"
    >
      <div class="flex items-center justify-between gap-3 flex-wrap">
        <div class="flex items-center gap-2 flex-wrap">
          <span class={STATUS_BADGE[delivery.status]}>{delivery.status}</span>
          <span style="font-family:var(--f-mono);font-size:11.5px;color:var(--muted)">{when}</span>
          {delivery.replayOf !== null && <span class="badge muted">replay</span>}
          {delivery.messageIds.length > 0 && (
            <span style="font-family:var(--f-mono);font-size:11px;color:var(--muted)">
              → {delivery.messageIds.length} message{delivery.messageIds.length === 1 ? '' : 's'}
            </span>
          )}
        </div>
        <button
          type="button"
          class="btn btn-secondary btn-sm"
          disabled={busy !== null}
          onClick={() =>
            void run(`replay-${delivery.id}`, () =>
              replayNotificationDelivery(endpoint.slug, delivery.id),
            )
          }
        >
          {busy === `replay-${delivery.id}` ? 'Replaying…' : 'Replay'}
        </button>
      </div>
      {delivery.statusReason !== null && (
        <div style="font-family:var(--f-sans);font-size:12px;color:var(--muted)">
          {delivery.statusReason}
        </div>
      )}
      {delivery.bodyPreview.length > 0 && (
        <pre style="margin:0;font-family:var(--f-mono);font-size:11px;color:var(--muted);white-space:pre-wrap;word-break:break-all;max-height:72px;overflow:hidden">
          {delivery.bodyPreview.slice(0, 400)}
        </pre>
      )}
    </li>
  );
}

function LifecycleSection({ endpoint }: { endpoint: NotificationEndpointSummary }) {
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
              updateNotificationEndpoint(endpoint.slug, { enabled: !endpoint.enabled }),
            )
          }
        >
          {endpoint.enabled ? 'Disable endpoint' : 'Enable endpoint'}
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
              await deleteNotificationEndpoint(endpoint.slug);
              selectNotifications();
            });
          }}
        >
          {confirming ? 'Click again to permanently delete' : 'Delete endpoint'}
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
        Disabling makes the hook URL return 409 (senders back off but the config survives). Deleting
        removes the endpoint, its receipts, and any queued deliveries — the URL then 404s.
      </div>
    </SectionPanel>
  );
}

export function __resetNotificationDetailForTests(): void {
  sectionError.value = null;
  sectionBusy.value = null;
  detailError.value = null;
  metaDisplayName.value = '';
  metaDescription.value = '';
  metaLevel.value = 'info';
  metaTitle.value = '';
  metaTemplate.value = '';
  metaDedupeHeader.value = '';
  seededFor.value = null;
  targetsInput.value = '';
  authKind.value = 'hmac-sha256';
  authHeader.value = '';
  authPrefix.value = '';
  authProfile.value = '';
  secretInput.value = '';
  policyIfOffline.value = 'drop';
  policyIfBusy.value = 'now';
  policyDebounceMs.value = '0';
  policyDebounceMax.value = '20';
  confirmDelete.value = false;
}
