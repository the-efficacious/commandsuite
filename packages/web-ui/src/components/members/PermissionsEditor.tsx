/**
 * PermissionsEditor — fine-grained picker for a member's permissions.
 *
 *   Templates:  [ Full access ]  [ Coordinate objectives ]  [ baseline ]
 *   ┌──────────────────────────────────┐
 *   │ ☑ Manage members (members.manage)│  description…
 *   │ ☐ Create objectives              │
 *   │ ☐ Cancel objectives              │
 *   │ …                                │
 *   └──────────────────────────────────┘
 *
 * Controlled component: parent owns the permission list. Optional
 * creation templates replace the selection with copied leaves; they
 * are not stored as roles or permission references.
 */

import type { Permission } from 'csuite-sdk/types';
import { PERMISSION_META, type PermissionTemplate } from '../../lib/permissions.js';

export interface PermissionsEditorProps {
  value: readonly Permission[];
  templates?: readonly PermissionTemplate[];
  onChange: (next: Permission[]) => void;
  disabled?: boolean;
}

export function PermissionsEditor({
  value,
  templates,
  onChange,
  disabled,
}: PermissionsEditorProps) {
  const set = new Set(value);

  const togglePerm = (p: Permission) => {
    const next = new Set(set);
    if (next.has(p)) next.delete(p);
    else next.add(p);
    onChange([...next]);
  };

  const applyTemplate = (leaves: readonly Permission[]) => {
    onChange([...leaves]);
  };

  const clearAll = () => onChange([]);

  return (
    <div style="display:flex;flex-direction:column;gap:10px">
      {templates !== undefined && (
        <div class="flex flex-wrap items-center gap-2">
          <span class="eyebrow" style="margin:0;padding-right:4px">
            Templates
          </span>
          {templates.map((template) => (
            <button
              key={template.label}
              type="button"
              class="btn btn-ghost btn-sm"
              onClick={() => applyTemplate(template.permissions)}
              disabled={disabled}
              title={`Copy the "${template.label}" permission template`}
            >
              {template.label}
            </button>
          ))}
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            onClick={clearAll}
            disabled={disabled}
            style="color:var(--ef-text-muted)"
            title="Clear all permissions"
          >
            baseline
          </button>
        </div>
      )}

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:2px 14px;border:1px solid var(--ef-border);border-radius:8px;padding:8px;background:var(--ef-surface-raised)">
        {PERMISSION_META.map((meta) => {
          const checked = set.has(meta.key);
          return (
            <label
              key={meta.key}
              class="flex items-start gap-2"
              style={`padding:6px 8px;cursor:${disabled ? 'default' : 'pointer'};border-radius:6px;background:${checked ? 'var(--ef-surface)' : 'transparent'};border:1px solid ${checked ? 'var(--ef-border)' : 'transparent'}`}
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
                  <span style="font-family:var(--ef-font-body);font-weight:600;color:var(--ef-text);font-size:13px">
                    {meta.label}
                  </span>
                  <span style="font-family:var(--ef-font-mono);font-size:10.5px;color:var(--ef-text-muted);letter-spacing:.04em">
                    {meta.key}
                  </span>
                </span>
                <span
                  id={`perm-${meta.key}`}
                  style="display:block;font-family:var(--ef-font-body);font-size:11.5px;color:var(--ef-text-muted);line-height:1.45;margin-top:2px"
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
