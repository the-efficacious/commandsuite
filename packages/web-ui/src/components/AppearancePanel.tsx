/**
 * AppearancePanel — light / dark / auto theme picker.
 *
 * Three pill buttons (Light · Dark · Auto). The active mode is the
 * persisted user choice; the resolved palette currently in effect is
 * shown as a small "currently <light|dark>" caption beneath, so the
 * meaning of `auto` is always visible.
 */

import { effectiveTheme, setThemeMode, type ThemeMode, themeMode } from '../lib/theme.js';
import { Monitor, Moon, Sun } from './icons/index.js';

interface Option {
  mode: ThemeMode;
  label: string;
  Icon: typeof Sun;
}

const OPTIONS: Option[] = [
  { mode: 'light', label: 'Light', Icon: Sun },
  { mode: 'dark', label: 'Dark', Icon: Moon },
  { mode: 'auto', label: 'Auto', Icon: Monitor },
];

export function AppearancePanel() {
  const mode = themeMode.value;
  const effective = effectiveTheme.value;

  return (
    <div class="flex flex-col gap-2 items-end" style="min-width:180px">
      <div
        class="flex items-stretch"
        style="border:1px solid var(--rule);border-radius:var(--r-sm);overflow:hidden"
      >
        {OPTIONS.map(({ mode: m, label, Icon }) => {
          const active = mode === m;
          return (
            <button
              key={m}
              type="button"
              aria-pressed={active}
              onClick={() => setThemeMode(m)}
              class="flex items-center gap-1.5"
              style={`padding:6px 10px;font-family:var(--f-sans);font-size:12px;font-weight:500;cursor:pointer;background:${active ? 'var(--ice)' : 'transparent'};color:${active ? 'var(--ink)' : 'var(--muted)'};border:0;border-right:1px solid var(--rule)`}
              title={`Use ${label.toLowerCase()} theme`}
            >
              <Icon size={13} aria-hidden="true" />
              {label}
            </button>
          );
        })}
      </div>
      {mode === 'auto' && (
        <div style="font-family:var(--f-mono);font-size:10.5px;letter-spacing:.04em;color:var(--muted);text-transform:uppercase">
          currently {effective}
        </div>
      )}
    </div>
  );
}
