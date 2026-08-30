/**
 * Reveal — shared one-time secret banner + copy control.
 *
 * The server returns tokens / TOTP secrets exactly once; the UI must
 * surface them immediately and stop showing them on dismiss. Both the
 * MembersPanel create/rotate/enroll flows and the MemberProfile Manage
 * tab share this component so the affordances look identical.
 */

import type {
  CreateMemberPendingResponse,
  CreateMemberResponse,
  EnrollTotpResponse,
  RotateTokenResponse,
} from 'csuite-sdk/types';
import { useState } from 'preact/hooks';

export type Reveal =
  | { kind: 'create'; response: Extract<CreateMemberResponse, { credentialMode: 'bootstrap' }> }
  | { kind: 'pending'; response: CreateMemberPendingResponse }
  | { kind: 'rotate'; name: string; response: RotateTokenResponse }
  | { kind: 'totp'; name: string; response: EnrollTotpResponse };

export function revealTargetName(r: Reveal): string {
  return r.kind === 'create' || r.kind === 'pending' ? r.response.member.name : r.name;
}

export interface RevealBannerProps {
  reveal: Reveal;
  onDismiss: () => void;
}

export function RevealBanner({ reveal: r, onDismiss }: RevealBannerProps) {
  let title: string;
  const fields: Array<{ label: string; value: string }> = [];
  if (r.kind === 'create') {
    title = `Created '${r.response.member.name}'`;
    fields.push({ label: 'Bearer token', value: r.response.token });
  } else if (r.kind === 'pending') {
    title = `Created '${r.response.member.name}' — pending enrolment`;
  } else if (r.kind === 'rotate') {
    title = `Rotated token for '${r.name}'`;
    fields.push({ label: 'Bearer token', value: r.response.token });
  } else {
    title = `Re-enrolled TOTP for '${r.name}'`;
    fields.push({ label: 'TOTP secret', value: r.response.totpSecret });
    fields.push({ label: 'otpauth URI', value: r.response.totpUri });
  }

  return (
    <div class="banner" data-state="caution" role="alert" style="margin-bottom:18px">
      <div style="min-width:0">
        <div class="banner-title">{title}</div>
        <div class="banner-body">
          <div style="display:flex;flex-direction:column;gap:10px;margin-top:6px">
            {fields.map((f) => (
              <SecretField key={f.label} label={f.label} value={f.value} />
            ))}
          </div>
          {r.kind === 'pending' ? (
            <div style="margin-top:12px;color:var(--ef-text-muted)">
              No credential was created. Run <code>csuite connect</code> as this member, then
              approve its device code with{' '}
              <code>
                csuite connect approve --code &lt;code&gt; --member {r.response.member.name}
              </code>
              .
            </div>
          ) : (
            <div style="margin-top:12px;font-style:italic;color:var(--ef-text-muted)">
              Save these now — they are not persisted anywhere else. Dismissing this banner hides
              them forever.
            </div>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        style="color:var(--ef-text-muted);padding:2px;border-radius:var(--ef-radius-xs);line-height:1"
      >
        ×
      </button>
    </div>
  );
}

function SecretField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const [shown, setShown] = useState(false);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — user can still select once revealed */
    }
  };

  const display = shown ? value : '•'.repeat(32);
  const btnBase =
    'font-family:var(--ef-font-body);font-size:11.5px;background:var(--ef-surface);border:none;border-left:1px solid var(--ef-border);padding:0 14px;cursor:pointer;letter-spacing:.04em;text-transform:uppercase;font-weight:600;white-space:nowrap';

  return (
    <div>
      <div style="font-family:var(--ef-font-body);font-size:11px;color:var(--ef-text-muted);letter-spacing:.04em;text-transform:uppercase;margin-bottom:4px">
        {label}
      </div>
      <div style="display:flex;align-items:stretch;border:1px solid var(--ef-border);border-radius:var(--ef-radius-sm);overflow:hidden;background:var(--ef-surface-raised)">
        <input
          type="text"
          readOnly
          value={display}
          aria-label={shown ? label : `${label} (hidden)`}
          onFocus={(e) => {
            if (shown) (e.currentTarget as HTMLInputElement).select();
          }}
          style={`flex:1;font-family:var(--ef-font-mono);font-size:12.5px;padding:8px 10px;background:transparent;color:var(--ef-text);border:none;outline:none;min-width:0;letter-spacing:${shown ? 'normal' : '1px'}`}
        />
        <button
          type="button"
          onClick={() => setShown((s) => !s)}
          aria-label={shown ? `Hide ${label}` : `Show ${label}`}
          style={`${btnBase};color:var(--ef-text);min-width:68px`}
        >
          {shown ? 'Hide' : 'Show'}
        </button>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={`Copy ${label}`}
          style={`${btnBase};color:${copied ? 'var(--ef-lamp-nominal)' : 'var(--ef-text)'};min-width:82px`}
        >
          {copied ? '✓ Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}
