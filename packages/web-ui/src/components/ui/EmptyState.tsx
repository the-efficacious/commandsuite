/**
 * EmptyState — the "nothing here yet" card used by panels with zero
 * items. Uses the existing `.empty` class from theme.css so the look
 * matches across panels.
 */

import type { ComponentChildren } from 'preact';

export interface EmptyStateProps {
  title: string;
  message?: ComponentChildren;
  action?: ComponentChildren;
}

export function EmptyState({ title, message, action }: EmptyStateProps) {
  return (
    <div class="empty">
      <h4>{title}</h4>
      {message && <p>{message}</p>}
      {action && <div style="margin-top:12px">{action}</div>}
    </div>
  );
}
