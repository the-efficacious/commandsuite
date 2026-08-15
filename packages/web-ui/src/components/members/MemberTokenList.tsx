/**
 * MemberTokenList — list a member's active bearer tokens with
 * per-row revoke. Surfaces metadata only (label, origin, created,
 * last used, expires); the plaintext lives nowhere in the UI.
 *
 * Useful for: spotting an enrollment you don't recognize before it's
 * used, revoking a stolen device's token without nuking other
 * devices, auditing which `origin` (bootstrap / rotate / enroll)
 * each token came from.
 *
 * Permission: `members.manage` or self.
 */

import { signal } from '@preact/signals';
import type { TokenInfo, TokenOrigin } from 'csuite-sdk/types';
import { useEffect } from 'preact/hooks';
import { getClient } from '../../lib/client.js';
import { confirmDialog } from '../../lib/confirm.js';

export interface MemberTokenListProps {
  memberName: string;
  /** Optional inline style passthrough. */
  style?: string;
}

const tokensCache = new Map<string, TokenInfo[]>();

const loadingSignal = signal<Set<string>>(new Set());
const errorSignal = signal<Map<string, string>>(new Map());
const refreshTick = signal(0);
const busyId = signal<string | null>(null);

async function loadTokens(memberName: string): Promise<void> {
  loadingSignal.value = new Set(loadingSignal.value).add(memberName);
  errorSignal.value = new Map(errorSignal.value);
  errorSignal.value.delete(memberName);
  try {
    const tokens = await getClient().listTokens(memberName);
    tokensCache.set(memberName, tokens);
  } catch (err) {
    const next = new Map(errorSignal.value);
    next.set(memberName, err instanceof Error ? err.message : String(err));
    errorSignal.value = next;
  } finally {
    const next = new Set(loadingSignal.value);
    next.delete(memberName);
    loadingSignal.value = next;
    refreshTick.value++;
  }
}

async function revokeRow(memberName: string, token: TokenInfo): Promise<void> {
  if (
    !(await confirmDialog({
      title: `Revoke this token for '${memberName}'?`,
      body:
        `${token.label || '(no label)'} · ${token.origin} · created ${formatTime(token.createdAt)}. ` +
        'Any device currently using this token will get 401 on its next request.',
      verb: 'Revoke',
    }))
  ) {
    return;
  }
  busyId.value = token.id;
  try {
    await getClient().revokeToken(memberName, token.id);
    // Optimistic local removal so the row disappears without a
    // round-trip; the next loadTokens() on remount confirms.
    const cached = tokensCache.get(memberName) ?? [];
    tokensCache.set(
      memberName,
      cached.filter((t) => t.id !== token.id),
    );
    refreshTick.value++;
  } catch (err) {
    alert(err instanceof Error ? err.message : String(err));
    // Force a server refresh on failure so the row state matches.
    await loadTokens(memberName);
  } finally {
    busyId.value = null;
  }
}

function formatTime(epochMs: number | null): string {
  if (epochMs === null) return 'never';
  const d = new Date(epochMs);
  // YYYY-MM-DD HH:MM (24h, UTC) — terse + unambiguous in any locale.
  const iso = d.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z`;
}

function originLabel(origin: TokenOrigin): string {
  switch (origin) {
    case 'bootstrap':
      return 'config-file';
    case 'rotate':
      return 'rotated';
    case 'enroll':
      return 'device-code';
  }
}

function originAccent(origin: TokenOrigin): string {
  // Subtle color accents to make device-code tokens visually
  // distinct from the bootstrap/rotated ones — the device-code
  // path is the new-and-recommended one, so it gets a nominal
  // (positive) accent. bootstrap/rotated stay neutral.
  switch (origin) {
    case 'enroll':
      return 'var(--ef-lamp-nominal)';
    case 'rotate':
      return 'var(--ef-text-muted)';
    case 'bootstrap':
      return 'var(--ef-text-muted)';
  }
}

export function MemberTokenList({ memberName, style }: MemberTokenListProps) {
  // Subscribe to the refresh tick so tokens render after async loads.
  void refreshTick.value;
  useEffect(() => {
    void loadTokens(memberName);
  }, [memberName]);

  const tokens = tokensCache.get(memberName);
  const loading = loadingSignal.value.has(memberName);
  const error = errorSignal.value.get(memberName) ?? null;

  return (
    <section class="card" style={`padding:16px;${style ?? ''}`}>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <div class="eyebrow">Bearer tokens</div>
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          onClick={() => void loadTokens(memberName)}
          disabled={loading}
          title="Refresh"
        >
          {loading ? '…' : '↻'}
        </button>
      </div>

      {error !== null && (
        <div
          role="alert"
          style="font-family:var(--ef-font-body);font-size:12.5px;color:var(--ef-lamp-alarm);background:var(--ef-lamp-alarm-ground);border:1px solid var(--ef-lamp-alarm);border-radius:var(--ef-radius-sm);padding:8px 10px;margin-bottom:10px"
        >
          {error}
        </div>
      )}

      {tokens === undefined && !error && (
        <div style="font-family:var(--ef-font-mono);font-size:12px;color:var(--ef-text-muted)">
          Loading…
        </div>
      )}

      {tokens !== undefined && tokens.length === 0 && (
        <div style="font-family:var(--ef-font-mono);font-size:12px;color:var(--ef-text-muted)">
          No active tokens. Run <code>csuite connect</code> on a device to enroll one.
        </div>
      )}

      {tokens !== undefined && tokens.length > 0 && (
        <ul style="list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:8px">
          {tokens.map((t) => (
            <li
              key={t.id}
              style="display:grid;grid-template-columns:1fr auto;gap:6px 16px;padding:10px 12px;background:var(--ef-surface-sunken);border-radius:var(--ef-radius-sm);border:1px solid var(--ef-border)"
            >
              <div>
                <div style="display:flex;align-items:center;gap:8px;font-family:var(--ef-font-body);font-size:13px;color:var(--ef-text)">
                  <span style="font-weight:600">{t.label || '(unlabeled)'}</span>
                  <span
                    style={`font-family:var(--ef-font-mono);font-size:10px;letter-spacing:.06em;text-transform:uppercase;padding:2px 6px;border:1px solid ${originAccent(t.origin)};color:${originAccent(t.origin)};border-radius:3px`}
                  >
                    {originLabel(t.origin)}
                  </span>
                </div>
                <div style="font-family:var(--ef-font-mono);font-size:11px;color:var(--ef-text-muted);margin-top:4px;display:flex;flex-wrap:wrap;gap:12px">
                  <span>created {formatTime(t.createdAt)}</span>
                  <span>last used {formatTime(t.lastUsedAt)}</span>
                  {t.expiresAt !== null && <span>expires {formatTime(t.expiresAt)}</span>}
                  {t.createdBy !== null && <span>by {t.createdBy}</span>}
                </div>
              </div>
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                onClick={() => void revokeRow(memberName, t)}
                disabled={busyId.value !== null}
                style="color:var(--ef-lamp-alarm);align-self:start"
                title="Revoke this token"
              >
                {busyId.value === t.id ? '…' : 'Revoke'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function __resetMemberTokenListForTests(): void {
  tokensCache.clear();
  loadingSignal.value = new Set();
  errorSignal.value = new Map();
  busyId.value = null;
  refreshTick.value = 0;
}
