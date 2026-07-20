/**
 * ContextDrawer — right-side slide-in for quick-peek details.
 *
 * Phase 1 ships the primitive but nothing uses it. Phase 3 (inbox)
 * and follow-ups will wire content: inbox item preview, objective
 * quick-peek, member hover card expansion.
 *
 * Behavior:
 *   - When `open` is false, the column takes no space (rendered null).
 *   - When `open` is true, renders a fixed-width panel with a close
 *     button and the children as content.
 *   - On narrow viewports the drawer covers the full width as a modal.
 */

import type { ComponentChildren } from 'preact';

export interface ContextDrawerProps {
  open: boolean;
  title?: ComponentChildren;
  onClose: () => void;
  children: ComponentChildren;
}

export function ContextDrawer({ open, title, onClose, children }: ContextDrawerProps) {
  if (!open) return null;
  return (
    <aside
      class="flex flex-col flex-shrink-0 md:static md:w-96 fixed inset-y-0 right-0 z-40 w-[85vw] max-w-96"
      style="background:var(--paper);border-left:1px solid var(--rule);padding-right:env(safe-area-inset-right);padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)"
      aria-label="Context details"
    >
      <header
        class="flex items-center justify-between flex-shrink-0"
        style="padding:12px 16px;border-bottom:1px solid var(--rule)"
      >
        <div class="min-w-0 eyebrow">{title ?? 'Details'}</div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close details"
          style="background:none;border:none;font-size:20px;line-height:1;color:var(--muted);cursor:pointer;padding:4px"
        >
          ×
        </button>
      </header>
      <div class="flex-1 overflow-y-auto" style="padding:16px">
        {children}
      </div>
    </aside>
  );
}
