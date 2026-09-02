/**
 * Permissions — UI-side metadata and summary helpers.
 *
 * The server vocabulary is a set of composable leaves (`team.manage`,
 * `members.manage`, `objectives.create`, …). Permission templates are
 * a create-form convenience only: applying one copies its leaves into
 * the selection and creates no durable role or privilege category.
 */

import type { Permission } from 'csuite-sdk/types';
import { PERMISSIONS } from 'csuite-sdk/types';

export interface PermissionMeta {
  key: Permission;
  label: string;
  description: string;
}

export interface PermissionTemplate {
  label: string;
  permissions: readonly Permission[];
}

/** One-shot helpers shown only while creating a member. */
export const MEMBER_CREATION_PERMISSION_TEMPLATES: readonly PermissionTemplate[] = [
  { label: 'Full access', permissions: [...PERMISSIONS] },
  {
    label: 'Coordinate objectives',
    permissions: [
      'objectives.create',
      'objectives.cancel',
      'objectives.reassign',
      'objectives.watch',
    ],
  },
];

/**
 * Human copy for each leaf. Ordered roughly by blast-radius (most
 * dangerous first) so the checkbox grid reads top-to-bottom as a
 * natural trust ladder.
 */
export const PERMISSION_META: readonly PermissionMeta[] = [
  {
    key: 'team.manage',
    label: 'Team settings',
    description: 'Edit the team name and shared context.',
  },
  {
    key: 'members.manage',
    label: 'Manage members',
    description: 'Add / remove / edit teammates, rotate their tokens, re-enroll TOTP.',
  },
  {
    key: 'channels.manage',
    label: 'Manage channels',
    description: 'Rename, describe, re-scope, archive, and audit team channels.',
  },
  {
    key: 'team_process.manage',
    label: 'Manage process',
    description: 'Create and edit the team process that binds every member.',
  },
  {
    key: 'members.context',
    label: "Control members' context",
    description:
      "Ask another member's runner to compact or clear its agent context. Interrupts live work; controlling your own needs no permission.",
  },
  {
    key: 'objectives.create',
    label: 'Create objectives',
    description: 'Create and assign objectives, and inspect the team-wide objective ledger.',
  },
  {
    key: 'objectives.cancel',
    label: 'Intervene in objectives',
    description: "Change another assignee's status or cancel objectives you did not originate.",
  },
  {
    key: 'objectives.reassign',
    label: 'Reassign objectives',
    description: 'Move a non-terminal objective to a different assignee.',
  },
  {
    key: 'objectives.watch',
    label: 'Manage objective watchers',
    description: 'Change watchers on objectives you did not originate.',
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

export interface PermissionSummary {
  /**
   * `baseline`: no permissions.
   * `custom`:   at least one leaf but doesn't match any preset.
   */
  kind: 'baseline' | 'custom';
  /** Human label based only on the resolved leaf count. */
  label: string;
  /** Leaf count (excludes preset-name expansion — just the resolved leaves). */
  count: number;
}

export function summarizePermissions(permissions: readonly Permission[]): PermissionSummary {
  if (permissions.length === 0) {
    return { kind: 'baseline', label: 'baseline', count: 0 };
  }
  return {
    kind: 'custom',
    label: `${permissions.length} permission${permissions.length === 1 ? '' : 's'}`,
    count: permissions.length,
  };
}

/** Short privilege tag for dense rows. Returns `null` if nothing to show. */
export function privilegeTag(summary: PermissionSummary): string | null {
  if (summary.kind === 'baseline') return null;
  return String(summary.count);
}
