/**
 * PermissionsEditor — fine-grained picker for a member's permissions.
 *
 *   Quick apply:  [ admin ]  [ operator ]  [ baseline ]
 *   ┌──────────────────────────────────┐
 *   │ ☑ Manage members (members.manage)│  description…
 *   │ ☐ Create objectives              │
 *   │ ☐ Cancel objectives              │
 *   │ …                                │
 *   └──────────────────────────────────┘
 *
 * Controlled component: parent owns the permission list. Preset
 * buttons are a courtesy — clicking one replaces the full selection
 * with that preset's leaves, but the checkboxes remain the source of
 * truth so any custom mix is submittable.
 */

import type { Permission, PermissionPresets } from 'csuite-sdk/types';
import { PERMISSION_META } from '../../lib/permissions.js';

export interface PermissionsEditorProps {
  value: readonly Permission[];
  presets: PermissionPresets;
  onChange: (next: Permission[]) => void;
  disabled?: boolean;
}

export function PermissionsEditor({ value, presets, onChange, disabled }: PermissionsEditorProps) {
  const set = new Set(value);
  const presetEntries = Object.entries(presets);

  const togglePerm = (p: Permission) => {
    const next = new Set(set);
    if (next.has(p)) next.delete(p);
    else next.add(p);
    onChange([...next]);
  };

  const applyPreset = (leaves: readonly Permission[]) => {
    onChange([...leaves]);
  };

  const clearAll = () => onChange([]);

  return (
    <div style="display:flex;flex-direction:column;gap:10px">
      {(presetEntries.length > 0 || true) && (
        <div class="flex flex-wrap items-center gap-2">
          <span class="eyebrow" style="margin:0;padding-right:4px">
            Quick apply
          </span>
          {presetEntries.map(([name, leaves]) => (
            <button
              key={name}
              type="button"
              class="btn btn-ghost btn-sm"
              onClick={() => applyPreset(leaves)}
              disabled={disabled}
              title={`Set to the "${name}" preset`}
            >
              {name}
            </button>
          ))}
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            onClick={clearAll}
            disabled={disabled}
            style="color:var(--muted)"
            title="Clear all permissions"
          >
            baseline
          </button>
        </div>
      )}

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:2px 14px;border:1px solid var(--rule);border-radius:8px;padding:8px;background:var(--ice)">
        {PERMISSION_META.map((meta) => {
          const checked = set.has(meta.key);
          return (
            <label
              key={meta.key}
              class="flex items-start gap-2"
              style={`padding:6px 8px;cursor:${disabled ? 'default' : 'pointer'};border-radius:6px;background:${checked ? 'var(--paper)' : 'transparent'};border:1px solid ${checked ? 'var(--rule)' : 'transparent'}`}
              title={meta.description}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => togglePerm(meta.key)}
                disabled={disabled}
                style="margin-top:3px;flex-shrink:0"
                aria-describedby={`perm-${meta.key}`}
              />
              <span class="min-w-0 flex-1">
                <span class="flex items-baseline gap-2 flex-wrap">
                  <span style="font-family:var(--f-sans);font-weight:600;color:var(--ink);font-size:13px">
                    {meta.label}
                  </span>
                  <span style="font-family:var(--f-mono);font-size:10.5px;color:var(--muted);letter-spacing:.04em">
                    {meta.key}
                  </span>
                </span>
                <span
                  id={`perm-${meta.key}`}
                  style="display:block;font-family:var(--f-sans);font-size:11.5px;color:var(--muted);line-height:1.45;margin-top:2px"
                >
                  {meta.description}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
