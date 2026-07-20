/**
 * Header — slim top bar: brand left, search centered. Right column
 * is empty by design — the viewer's identity anchor lives in the
 * NavColumn footer (or in the host-provided rail in embedded mode),
 * never both. One affordance, one place.
 *
 *   ☰  ▲                   [⌕  Jump to…   ⌘K]
 *
 * The search pill is the visual anchor — prominent, centered, and
 * the same ⌘K launcher that's available globally.
 *
 * Connection health surfaces only via `DisconnectedBanner` when
 * something is wrong — no persistent "ONLINE" pill in chrome.
 */

import { embeddedShell } from '../lib/embedded.js';
import { identity } from '../lib/identity.js';
import { openPalette } from '../lib/palette.js';
import { isSidebarOpen, openSidebar } from '../lib/view.js';
import { BrandMark as BrandHeptagon, Menu, Search } from './icons/index.js';

export function Header() {
  // Header renders only after identity is set so the rest of the
  // shell tree has a viewer to anchor to. Rendering pre-identity
  // would flash an unbranded top bar against an empty body.
  if (identity.value === null) return null;
  const drawerOpen = isSidebarOpen.value;
  const embedded = embeddedShell.value;

  // The header gets a `topbar` class that owns its responsive padding
  // via `theme.css` media queries. Embedded mode ALSO gets `topbar-
  // embedded`, which drops the left padding to 0 so the 64px brand
  // column sits flush against the viewport edge (above the outer
  // rail). Below 700, the rail collapses to a drawer and `.topbar-
  // embedded` reverts to normal left padding.
  return (
    <header
      class={`topbar${embedded ? ' topbar-embedded' : ''} flex items-center flex-shrink-0 relative z-40 gap-2`}
    >
      <div class="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
        <button
          type="button"
          onClick={openSidebar}
          aria-label="Open navigation"
          aria-expanded={drawerOpen}
          class="md:hidden flex-shrink-0"
          style={
            embedded
              ? 'color:var(--graphite);padding:10px'
              : 'color:var(--graphite);padding:10px;margin:-10px -6px -10px -10px'
          }
        >
          <Menu size={20} aria-hidden="true" />
        </button>

        <BrandMark embedded={embedded} />
      </div>

      <div class="flex justify-center flex-shrink-0" style="flex:2 1 auto;max-width:480px">
        <SearchButton />
      </div>

      {/* Right column kept for layout balance so the search pill stays
          centered. Identity affordance lives in the NavColumn footer
          (and, in embedded mode, the host's outer rail). */}
      <div class="flex items-center justify-end flex-1 min-w-0" aria-hidden="true" />
    </header>
  );
}

/**
 * Heptagon mark. In embedded mode it sits inside a 64px-wide column
 * that aligns horizontally with the team-switcher rail directly
 * below — so the brand sits exactly above the rail's vertical axis,
 * sized to match the rail icons (44px). In standalone mode (no rail)
 * it's a smaller inline mark with no alignment column.
 */
function BrandMark({ embedded }: { embedded: boolean }) {
  const mark = <BrandHeptagon size={26} class="flex-shrink-0" style="color:var(--ink)" />;

  if (!embedded) return mark;

  // The 64px brand column is the topbar's alignment anchor for the
  // outer rail beneath it. Below 700 the rail collapses into a drawer
  // and the column has nothing to align to — `.brand-column` CSS
  // unsets the fixed width at that breakpoint so the mark falls back
  // to inline placement.
  return <div class="brand-column flex items-center justify-center flex-shrink-0">{mark}</div>;
}

/**
 * Search affordance. On ≥sm renders as a mock input with the ⌘K
 * hint; on mobile it collapses to just an icon. Clicking opens the
 * palette — the real input lives inside the modal.
 */
function SearchButton() {
  return (
    <button
      type="button"
      onClick={openPalette}
      aria-label="Open command palette"
      title="Search and jump (⌘K)"
      class="flex items-center w-full"
      style="background:var(--ice);border:1px solid var(--rule);border-radius:var(--r-sm);padding:7px 12px;gap:10px;color:var(--muted);cursor:pointer;font-family:var(--f-sans);font-size:13px;max-width:100%;transition:border-color .15s var(--ease,ease)"
    >
      <Search size={14} aria-hidden="true" class="flex-shrink-0" />
      <span
        class="hidden sm:inline flex-1"
        style="text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0"
      >
        Jump to member, objective, thread…
      </span>
      <span class="sm:hidden flex-1" style="text-align:left">
        Search…
      </span>
      <span
        class="hidden sm:inline flex-shrink-0"
        style="font-family:var(--f-mono);font-size:10.5px;letter-spacing:.06em;color:var(--muted);background:var(--paper);border:1px solid var(--rule);border-radius:var(--r-xs);padding:1px 6px"
      >
        ⌘K
      </span>
    </button>
  );
}
