/**
 * Reveal — shared one-time secret banner + copy control.
 *
 * The server returns tokens / TOTP secrets exactly once; the UI must
 * surface them immediately and stop showing them on dismiss. Both the
 * MembersPanel create/rotate/enroll flows and the MemberProfile Manage
 * tab share this component so the affordances look identical.
 */

import type {
  CreateMemberResponse,
  EnrollTotpResponse,
  RotateTokenResponse,
} from 'csuite-sdk/types';
import { useState } from 'preact/hooks';

export type Reveal =
  | { kind: 'create'; response: CreateMemberResponse }
  | { kind: 'rotate'; name: string; response: RotateTokenResponse }
  | { kind: 'totp'; name: string; response: EnrollTotpResponse };

export function revealTargetName(r: Reveal): string {
  return r.kind === 'create' ? r.response.member.name : r.name;
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
  } else if (r.kind === 'rotate') {
    title = `Rotated token for '${r.name}'`;
    fields.push({ label: 'Bearer token', value: r.response.token });
  } else {
    title = `Re-enrolled TOTP for '${r.name}'`;
    fields.push({ label: 'TOTP secret', value: r.response.totpSecret });
    fields.push({ label: 'otpauth URI', value: r.response.totpUri });
  }

  return (
    <div
      class="callout"
      role="alert"
      style="margin-bottom:18px;background:var(--paper);border:1px solid var(--ink);padding:14px 16px;display:flex;gap:12px;align-items:flex-start"
    >
      <div class="icon" aria-hidden="true">
        ✓
      </div>
      <div class="body" style="flex:1;min-width:0">
        <div class="title">{title}</div>
        <div style="display:flex;flex-direction:column;gap:10px;margin-top:10px">
          {fields.map((f) => (
            <SecretField key={f.label} label={f.label} value={f.value} />
          ))}
        </div>
        <div style="margin-top:12px;font-family:var(--f-sans);font-size:12px;color:var(--muted);font-style:italic">
          Save these now — they are not persisted anywhere else. Dismissing this banner hides them
          forever.
        </div>
      </div>
      <button type="button" onClick={onDismiss} aria-label="Dismiss" class="close">
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
    'font-family:var(--f-sans);font-size:11.5px;background:var(--paper);border:none;border-left:1px solid var(--rule);padding:0 14px;cursor:pointer;letter-spacing:.04em;text-transform:uppercase;font-weight:600;white-space:nowrap';

  return (
    <div>
      <div style="font-family:var(--f-sans);font-size:11px;color:var(--muted);letter-spacing:.04em;text-transform:uppercase;margin-bottom:4px">
        {label}
      </div>
      <div style="display:flex;align-items:stretch;border:1px solid var(--rule);border-radius:var(--r-sm);overflow:hidden;background:var(--ice)">
        <input
          type="text"
          readOnly
          value={display}
          aria-label={shown ? label : `${label} (hidden)`}
          onFocus={(e) => {
            if (shown) (e.currentTarget as HTMLInputElement).select();
          }}
          style={`flex:1;font-family:var(--f-mono);font-size:12.5px;padding:8px 10px;background:transparent;color:var(--ink);border:none;outline:none;min-width:0;letter-spacing:${shown ? 'normal' : '1px'}`}
        />
        <button
          type="button"
          onClick={() => setShown((s) => !s)}
          aria-label={shown ? `Hide ${label}` : `Show ${label}`}
          style={`${btnBase};color:var(--ink);min-width:68px`}
        >
          {shown ? 'Hide' : 'Show'}
        </button>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={`Copy ${label}`}
          style={`${btnBase};color:${copied ? 'var(--ok,#2d6a4f)' : 'var(--ink)'};min-width:82px`}
        >
          {copied ? '✓ Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}
