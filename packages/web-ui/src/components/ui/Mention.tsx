/**
 * Mention — the canonical way to render a member's name.
 *
 * Behavior:
 *   - Renders as a link (visually styled like existing sender chips)
 *   - Clicking navigates to the member's profile page `/@:name`
 *   - Hovering reveals a small card with avatar / role / DM action
 *
 * Drop-in replacement for ad-hoc `<span>{name}</span>` usages in
 * ObjectivesPanel assignee fields, MessageLine senders, roster rows,
 * objective watcher lists, etc. — anywhere a name appears and the
 * reader might want to jump to "who is this" or "DM them."
 */

import { signal } from '@preact/signals';
import type { ComponentChildren } from 'preact';
import { useId } from 'preact/hooks';
import { briefing } from '../../lib/briefing.js';
import { roster } from '../../lib/roster.js';
import { selectAgentDetail, selectDmWith } from '../../lib/view.js';

export interface MentionProps {
  /** Member name — `@` is added automatically in the render. */
  name: string;
  /** Omit the `@` prefix if the caller is rendering in a context (e.g. assignee: {name}) where it would read awkwardly. */
  plain?: boolean;
  /** Render as regular text (no link styling) but keep hover-card + click-to-profile behavior. */
  variant?: 'link' | 'text';
  /** Override displayed text (e.g. "you"). Hover card still shows the real profile. */
  label?: ComponentChildren;
  /** Inline style passthrough. */
  style?: string;
  /** Additional class names (merged into the base). */
  class?: string;
}

const openCardId = signal<string | null>(null);

export function Mention({
  name,
  plain = false,
  variant = 'link',
  label,
  style,
  class: klass,
}: MentionProps) {
  const cardId = useId();
  const show = () => {
    openCardId.value = cardId;
  };
  const hide = () => {
    if (openCardId.value === cardId) openCardId.value = null;
  };

  const classes = [variant === 'link' ? 'text-link-steel' : '', klass ?? '']
    .filter(Boolean)
    .join(' ');

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover is a visual enhancement; the nested button owns keyboard interaction
    <span
      class="relative inline-block"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocusIn={show}
      onFocusOut={hide}
    >
      <button
        type="button"
        onClick={() => selectAgentDetail(name)}
        class={classes}
        style={`background:none;border:none;padding:0;cursor:pointer;font:inherit;color:inherit;${style ?? ''}`}
        aria-describedby={openCardId.value === cardId ? cardId : undefined}
      >
        {label ?? (plain ? name : `@${name}`)}
      </button>
      {openCardId.value === cardId && <MemberHoverCard id={cardId} name={name} />}
    </span>
  );
}

/**
 * Close the hover card programmatically — used when a new card
 * opens elsewhere.
 */
export function __closeMentionCardsForTests(): void {
  openCardId.value = null;
}

function MemberHoverCard({ id, name }: { id: string; name: string }) {
  const b = briefing.value;
  const r = roster.value;
  const teammate =
    r?.teammates.find((t) => t.name === name) ?? b?.teammates.find((t) => t.name === name);
  const connected = r?.connected.find((c) => c.name === name)?.connected ?? 0;
  const online = connected > 0;
  const isSelf = b?.name === name;

  return (
    <div
      id={id}
      role="tooltip"
      class="absolute z-40 mt-1"
      style="background:var(--paper);border:1px solid var(--rule);border-radius:8px;box-shadow:0 8px 24px rgba(14,28,43,0.12);padding:10px 12px;min-width:220px;left:0;top:100%;font-family:var(--f-sans)"
    >
      <div class="flex items-center gap-2">
        <span class="avatar" aria-hidden="true">
          {initials(name)}
        </span>
        <div class="min-w-0 flex-1">
          <div
            class="font-display truncate"
            style="font-weight:700;letter-spacing:-0.01em;color:var(--ink);font-size:14px"
          >
            {name}
            {isSelf && (
              <span style="font-family:var(--f-mono);font-size:10px;letter-spacing:.14em;color:var(--muted);text-transform:uppercase;margin-left:6px">
                (you)
              </span>
            )}
          </div>
          {teammate && (
            <div
              class="truncate"
              style="font-family:var(--f-mono);font-size:10.5px;letter-spacing:.06em;color:var(--muted);text-transform:uppercase;margin-top:2px"
            >
              {teammate.role.title}
              <span style="color:var(--rule-strong)"> · </span>
              <span style={`color:var(--${online ? 'ok' : 'muted'})`}>
                {online ? '●' : '◇'} {online ? 'online' : 'offline'}
              </span>
            </div>
          )}
        </div>
      </div>
      {teammate?.role.description && (
        <div
          class="truncate"
          style="font-size:12px;color:var(--graphite);margin-top:8px;line-height:1.4"
        >
          {teammate.role.description}
        </div>
      )}
      <div style="display:flex;gap:6px;margin-top:10px">
        {!isSelf && (
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            onClick={(e) => {
              e.stopPropagation();
              selectDmWith(name);
              openCardId.value = null;
            }}
          >
            → DM
          </button>
        )}
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          onClick={(e) => {
            e.stopPropagation();
            selectAgentDetail(name);
            openCardId.value = null;
          }}
        >
          → Profile
        </button>
      </div>
    </div>
  );
}

function initials(name: string): string {
  const parts = name.split(/[\s_-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}`.toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}
