/**
 * Permissions — UI-side metadata and summary helpers.
 *
 * The server vocabulary is 7 composable leaves (`team.manage`,
 * `members.manage`, `objectives.create`, …) bundled by named presets
 * like "admin" or "operator" on the team config. Earlier UI code
 * collapsed members into 3 fixed bins (admin / operator / baseline),
 * which hid arbitrary custom mixes. These helpers replace that
 * collapse with a richer summary that still reduces cleanly for dense
 * sidebar rows but exposes the full set when space allows.
 */

import type { Permission, PermissionPresets } from 'csuite-sdk/types';
import { PERMISSIONS } from 'csuite-sdk/types';

export interface PermissionMeta {
  key: Permission;
  label: string;
  description: string;
}

/**
 * Human copy for each leaf. Ordered roughly by blast-radius (most
 * dangerous first) so the checkbox grid reads top-to-bottom as a
 * natural trust ladder.
 */
export const PERMISSION_META: readonly PermissionMeta[] = [
  {
    key: 'team.manage',
    label: 'Team settings',
    description: 'Edit team name, context, and permission presets.',
  },
  {
    key: 'members.manage',
    label: 'Manage members',
    description: 'Add / remove / edit teammates, rotate their tokens, re-enroll TOTP.',
  },
  {
    key: 'objectives.create',
    label: 'Create objectives',
    description: 'Post new objectives and assign them to teammates.',
  },
  {
    key: 'objectives.cancel',
    label: 'Cancel objectives',
    description: "Cancel an objective that's mid-flight.",
  },
  {
    key: 'objectives.reassign',
    label: 'Reassign objectives',
    description: 'Move an objective from one assignee to another.',
  },
  {
    key: 'objectives.watch',
    label: 'Manage watchers',
    description: 'Add or remove watchers on any objective, not just your own.',
  },
  {
    key: 'activity.read',
    label: 'Read activity',
    description: "View another member's LLM / tool activity timeline.",
  },
  {
    key: 'tools.manage',
    label: 'Manage tools',
    description:
      'Administer the tool-source registry: register sources, set credentials, bind members, define tools.',
  },
  {
    key: 'secrets.manage',
    label: 'Manage secrets',
    description:
      'Administer broker-held environment secrets: create them, set write-only values, bind members.',
  },
  {
    key: 'notifications.manage',
    label: 'Manage notifications',
    description:
      'Administer external-notification endpoints: register inbound webhooks, set write-only signing secrets, review and replay delivery receipts.',
  },
];

/** Stable order for leaf chips in displays — matches PERMISSIONS constant. */
export function sortLeaves(perms: readonly Permission[]): Permission[] {
  const set = new Set(perms);
  return PERMISSIONS.filter((p) => set.has(p));
}

/** True if `permissions` and `preset` contain the exact same leaves (order-independent). */
export function matchesPreset(
  permissions: readonly Permission[],
  preset: readonly Permission[],
): boolean {
  if (permissions.length !== preset.length) return false;
  const set = new Set(permissions);
  for (const p of preset) if (!set.has(p)) return false;
  return true;
}

/** Return the first preset name whose leaves exactly match `permissions`, or null. */
export function findExactPreset(
  permissions: readonly Permission[],
  presets: PermissionPresets,
): string | null {
  for (const [name, leaves] of Object.entries(presets)) {
    if (matchesPreset(permissions, leaves)) return name;
  }
  return null;
}

export interface PermissionSummary {
  /**
   * `baseline`: no permissions.
   * `preset`:   exact match to a named preset on the team.
   * `custom`:   at least one leaf but doesn't match any preset.
   */
  kind: 'baseline' | 'preset' | 'custom';
  /** Human label — "baseline" / "admin" / "operator" / "custom (3)" etc. */
  label: string;
  /** True when `members.manage` is present. Used for the sidebar quick tag. */
  isAdmin: boolean;
  /** Preset name when kind === 'preset', else null. */
  presetName: string | null;
  /** Leaf count (excludes preset-name expansion — just the resolved leaves). */
  count: number;
}

export function summarizePermissions(
  permissions: readonly Permission[],
  presets: PermissionPresets,
): PermissionSummary {
  const isAdmin = permissions.includes('members.manage');
  if (permissions.length === 0) {
    return { kind: 'baseline', label: 'baseline', isAdmin: false, presetName: null, count: 0 };
  }
  const preset = findExactPreset(permissions, presets);
  if (preset !== null) {
    return {
      kind: 'preset',
      label: preset,
      isAdmin,
      presetName: preset,
      count: permissions.length,
    };
  }
  return {
    kind: 'custom',
    label: `custom (${permissions.length})`,
    isAdmin,
    presetName: null,
    count: permissions.length,
  };
}

/** Short privilege tag for dense rows. Returns `null` if nothing to show. */
export function privilegeTag(summary: PermissionSummary): string | null {
  if (summary.isAdmin) return 'A';
  if (summary.kind === 'baseline') return null;
  // Non-admin preset or custom: take the first letter of the preset
  // name if we have one, or a generic marker otherwise.
  if (summary.kind === 'preset' && summary.presetName) {
    return summary.presetName.slice(0, 2).toUpperCase();
  }
  return 'C';
}
