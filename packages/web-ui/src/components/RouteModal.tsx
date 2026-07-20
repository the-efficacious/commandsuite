/**
 * RouteModal — overlay shell for routes that should feel modal
 * rather than full-screen. Used both by the standalone app (account
 * view) and by embedding hosts that surface team settings, team
 * creation, server authorization, etc., so context isn't lost when
 * a settings page opens.
 *
 * The wrapper supplies: a backdrop with blur, Escape + click-outside
 * + close-button dismissal, role="dialog" + aria-modal, and a
 * scrollable content region. Each child page owns its inner
 * heading/layout — this wrapper provides only the frame.
 */

import type { ComponentChildren } from 'preact';
import { useEffect } from 'preact/hooks';
import { X } from './icons/index.js';

export interface RouteModalProps {
  /**
   * Invoked on Escape, backdrop click, or close-button click.
   * Typically navigates back to the underlay route (e.g. the
   * thread / team the modal floated on top of).
   */
  onClose: () => void;
  /** Accessible label — most child pages own their own headings. */
  ariaLabel: string;
  /**
   * Visual size of the panel. Most settings/forms fit comfortably
   * in `lg`; flows with plan tables or embedded iframes can opt for
   * `xl`.
   */
  size?: 'md' | 'lg' | 'xl';
  children: ComponentChildren;
}

const SIZE_CLASS: Record<NonNullable<RouteModalProps['size']>, string> = {
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
};

export function RouteModal({ onClose, ariaLabel, size = 'lg', children }: RouteModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard dismissal is the global Escape handler bound in useEffect — onClick here is the click-outside convenience only
    <div
      class="fixed inset-0 z-50 flex items-center justify-center p-4"
      style="background:rgba(0,0,0,0.55);backdrop-filter:blur(2px)"
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        class={`relative w-full ${SIZE_CLASS[size]} rounded-2xl border shadow-2xl flex flex-col`}
        style="background:var(--paper);border-color:var(--rule);color:var(--ink);max-height:calc(100vh - 2rem)"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          title="Close (Esc)"
          class="absolute flex items-center justify-center"
          style="top:14px;right:14px;width:32px;height:32px;background:transparent;border:0;color:var(--muted);cursor:pointer;font-size:18px;line-height:1;border-radius:var(--r-xs);z-index:10"
        >
          <X size={14} aria-hidden="true" />
        </button>
        <div class="flex-1 overflow-y-auto" style="padding:0">
          {children}
        </div>
      </div>
    </div>
  );
}
