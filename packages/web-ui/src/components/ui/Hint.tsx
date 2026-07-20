/**
 * Hint — the lightweight inline status primitive.
 *
 * Sits below `.callout` (heavier) and toasts (global) in the feedback
 * hierarchy. Use for:
 *
 *   - Form-field validation hints ("must be at least 8 characters")
 *   - Inline confirmations ("Saved", "Copied")
 *   - Brief contextual warnings inside a card
 *
 * Renders inline (`inline-flex`), so it composes cleanly inside
 * label rows, beneath inputs, or wherever you'd put a one-line note.
 *
 * The icon is optional but recommended — the kind drives both the
 * icon glyph and the text color. Pass `icon={null}` to suppress.
 */

import type { ComponentChildren } from 'preact';
import { AlertCircle, AlertTriangle, CheckCircle2, Info } from '../icons/index.js';

export type HintKind = 'info' | 'success' | 'warn' | 'error';

export interface HintProps {
  kind?: HintKind;
  /** Override the default icon (`null` to suppress entirely). */
  icon?: ComponentChildren;
  children: ComponentChildren;
  class?: string;
}

const VARIANT_CLASS: Record<HintKind, string> = {
  info: '',
  success: 'success',
  warn: 'warn',
  error: 'err',
};

export function Hint({ kind = 'info', icon, children, class: className }: HintProps) {
  const variant = VARIANT_CLASS[kind];
  const classes = ['hint', variant, className].filter(Boolean).join(' ');
  const role = kind === 'warn' || kind === 'error' ? 'alert' : 'status';
  const resolvedIcon = icon === undefined ? <DefaultIcon kind={kind} /> : icon;
  return (
    <span class={classes} role={role}>
      {resolvedIcon !== null && (
        <span class="hint-icon" aria-hidden="true">
          {resolvedIcon}
        </span>
      )}
      <span>{children}</span>
    </span>
  );
}

function DefaultIcon({ kind }: { kind: HintKind }) {
  switch (kind) {
    case 'success':
      return <CheckCircle2 size={13} />;
    case 'warn':
      return <AlertTriangle size={13} />;
    case 'error':
      return <AlertCircle size={13} />;
    default:
      return <Info size={13} />;
  }
}
