/**
 * ErrorCallout — the canonical error banner. Wraps the `.callout.err`
 * class from theme.css with a consistent shape (icon + optional title
 * + message + optional retry/dismiss actions).
 */

import type { ComponentChildren } from 'preact';
import { AlertCircle, RefreshCw, X } from '../icons/index.js';

export interface ErrorCalloutProps {
  title?: string;
  message: ComponentChildren;
  onRetry?: () => void;
  onDismiss?: () => void;
  style?: string;
}

export function ErrorCallout({ title, message, onRetry, onDismiss, style }: ErrorCalloutProps) {
  return (
    <div role="alert" class="callout err" style={style}>
      <div class="icon" aria-hidden="true">
        <AlertCircle size={16} />
      </div>
      <div class="body">
        {title && <div class="title">{title}</div>}
        <div class="msg">{message}</div>
        {onRetry && (
          <button
            type="button"
            class="btn btn-ghost btn-sm flex items-center"
            style="margin-top:8px;gap:6px"
            onClick={onRetry}
          >
            <RefreshCw size={12} aria-hidden="true" />
            Retry
          </button>
        )}
      </div>
      {onDismiss && (
        <button type="button" onClick={onDismiss} aria-label="Dismiss" class="close">
          <X size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
