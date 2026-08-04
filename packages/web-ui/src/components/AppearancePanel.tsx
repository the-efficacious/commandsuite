/**
 * AppearancePanel — light / dark / auto theme picker.
 *
 * A segmented control (Light · Dark · Auto). The active mode is the
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
      <div class="segmented">
        {OPTIONS.map(({ mode: m, label, Icon }) => {
          const active = mode === m;
          return (
            <button
              key={m}
              type="button"
              aria-pressed={active}
              onClick={() => setThemeMode(m)}
              title={`Use ${label.toLowerCase()} theme`}
            >
              <Icon size={13} aria-hidden="true" /> {label}
            </button>
          );
        })}
      </div>
      {mode === 'auto' && (
        <div style="font-family:var(--ef-font-mono);font-size:10.5px;letter-spacing:.04em;color:var(--ef-text-muted);text-transform:uppercase">
          currently {effective}
        </div>
      )}
    </div>
  );
}
