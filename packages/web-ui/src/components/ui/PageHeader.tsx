/**
 * PageHeader — the top banner every content panel uses.
 *
 *   ━━ EYEBROW
 *   Title                            [actions]
 *   optional subtitle / description
 *
 * Used by ObjectivesPanel, MembersPanel, RosterPanel, MemberProfile,
 * etc. Replaces the ad-hoc "eyebrow + h2 + optional subtitle + maybe
 * a button off to the side" lockup that was copy-pasted across panels.
 */

import type { ComponentChildren } from 'preact';

export interface PageHeaderProps {
  eyebrow?: string;
  title: ComponentChildren;
  subtitle?: ComponentChildren;
  actions?: ComponentChildren;
}

export function PageHeader({ eyebrow, title, subtitle, actions }: PageHeaderProps) {
  return (
    <div
      class="flex flex-wrap items-end justify-between gap-3"
      style="margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--rule)"
    >
      <div class="min-w-0">
        {eyebrow && <div class="eyebrow">{eyebrow}</div>}
        <h2
          class="font-display"
          style="font-size:30px;font-weight:700;letter-spacing:-0.02em;color:var(--ink);line-height:1.1;margin-top:6px"
        >
          {title}
        </h2>
        {subtitle && (
          <div style="font-family:var(--f-sans);font-size:13px;color:var(--graphite);margin-top:8px;line-height:1.5">
            {subtitle}
          </div>
        )}
      </div>
      {actions && <div class="flex-shrink-0 flex items-center gap-2">{actions}</div>}
    </div>
  );
}
