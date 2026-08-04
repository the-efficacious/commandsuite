/**
 * EmptyState — the bench state panel used by panels with zero items:
 * sunken ground, centered, an optional mono state tag, one title, one
 * why, one action. `.empty` / `.state-tag` / `.state-why` come from
 * theme.css so the look matches across panels.
 */

import type { ComponentChildren } from 'preact';

export interface EmptyStateProps {
  /** Mono state tag rendered above the title (e.g. "NO SIGNALS"). */
  tag?: string;
  title: string;
  message?: ComponentChildren;
  action?: ComponentChildren;
}

export function EmptyState({ tag, title, message, action }: EmptyStateProps) {
  return (
    <div class="empty">
      {tag && <div class="state-tag">{tag}</div>}
      <h4>{title}</h4>
      {message && <p class="state-why">{message}</p>}
      {action && <div>{action}</div>}
    </div>
  );
}
