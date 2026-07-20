/**
 * AppShell — the top-level layout for the authenticated app.
 *
 *   ┌─────────────────────────────────────────────┐
 *   │ Header                                      │
 *   ├──────┬───────┬──────────────┬──────────────┤
 *   │ Rail │ Nav   │ Main         │ Drawer?      │
 *   │  ?   │       │              │              │
 *   └──────┴───────┴──────────────┴──────────────┘
 *
 * Four slots in the row below the header: an optional outer
 * `leftRail` (host-provided team switcher in multi-team contexts),
 * `nav` (mid-left), `main` (center), and an optional `drawer` on the
 * right. System messages (disconnect warnings, mount errors, plan-cap
 * hits, etc.) render through the toast stack at bottom-right —
 * AppShell intentionally owns no layout-pushing banner region.
 *
 * This component is intentionally dumb about its contents. It owns
 * the flex/grid structure and the bleed-through of safe-area insets;
 * children own their own padding and scroll behavior.
 */

import type { ComponentChildren } from 'preact';
import { useEffect } from 'preact/hooks';
import { closeInspector, isInspectorOpen } from '../../lib/inspector.js';
import { closeSidebar, isSidebarOpen } from '../../lib/view.js';

export interface AppShellProps {
  header: ComponentChildren;
  nav: ComponentChildren;
  main: ComponentChildren;
  drawer?: ComponentChildren;
  /** Optional outer rail (e.g. multi-team switcher) rendered before nav. */
  leftRail?: ComponentChildren;
}

export function AppShell({ header, nav, main, drawer, leftRail }: AppShellProps) {
  // The inner row is `position: relative` so the activity-inspector
  // overlay (below 1100) and the navcol drawer (below 900) anchor to
  // it instead of the viewport — the topbar stays fully visible above
  // every overlay.
  //
  // `--rail-w` exposes the leftRail's width to descendant CSS so the
  // navcol drawer's translation can clear it (`translateX(calc(-100%
  // - var(--rail-w)))`). When no leftRail is mounted (OSS) the var
  // stays 0px and the drawer translates by its own width only.
  const railWidth = leftRail !== undefined ? '64px' : '0px';
  const navOpen = isSidebarOpen.value;
  const inspectorOpen = isInspectorOpen.value;
  const anyDrawerOpen = navOpen || inspectorOpen;

  const dismissAll = () => {
    if (navOpen) closeSidebar();
    if (inspectorOpen) closeInspector();
  };

  // Auto-close any overlay whose breakpoint has scrolled past — if
  // the user opens the inspector at narrow width and then resizes
  // wider, the panel becomes part of the inline layout but the
  // signal would otherwise stay true and falsely activate the
  // backdrop. Same logic for the navcol drawer at ≥900.
  useEffect(() => {
    const onResize = () => {
      if (window.innerWidth >= 1100) closeInspector();
      if (window.innerWidth >= 900) closeSidebar();
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return (
    <>
      {header}
      <main class="flex flex-col min-h-0 flex-1 overflow-hidden">
        <div class="flex flex-1 min-h-0 overflow-hidden relative" style={`--rail-w:${railWidth}`}>
          {leftRail}
          {nav}
          <section class="flex-1 flex flex-col min-w-0 min-h-0">{main}</section>
          {drawer}
          {/* Backdrop is `aria-hidden` and decorative — keyboard users
              dismiss via Escape (see TeamShell global handler) or the
              individual close buttons inside each drawer. */}
          <div
            class={`drawer-backdrop${anyDrawerOpen ? ' is-active' : ''}`}
            onClick={dismissAll}
            aria-hidden="true"
          />
        </div>
      </main>
    </>
  );
}
