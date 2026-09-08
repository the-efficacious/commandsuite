/**
 * Compile-time negatives for the permission-preset write path
 * (commandsuite#21, #79).
 *
 * Presets are read-only compatibility and are never re-opened: rows a
 * pre-consolidation broker wrote, resolved into leaves on every member
 * load, and creatable by nothing. `TeamStore.setPreset`,
 * `deletePreset` and `membersReferencingPreset` had no production
 * caller — only a test double and its seeder — while a doc comment on
 * `deletePreset` planned work for a caller that did not exist. That is
 * what makes a frozen subsystem read as half-wired to the next person
 * in the file.
 *
 * `@ts-expect-error` INVERTS the question, per the repo's precedent in
 * `diagnostics-boundary.test-d.ts`. Asserting "the methods are gone" by
 * eye is a one-time check nobody repeats; here the compiler fails the
 * build with `TS2578: unused '@ts-expect-error'` the moment any of them
 * comes back — which is the only thing that keeps a deletion deleted.
 *
 * The READ path is asserted the other way round below: it must still
 * compile, because it is the only reason an older database loads at
 * all. Its runtime behaviour is pinned in
 * `permission-aliases.test.ts`, where a legacy `permission_presets` row
 * is inserted as an old broker left it and resolved through
 * `resolvePermissions`.
 *
 * Type-only: no runtime assertions, checked by `tsc --noEmit`.
 */

import type { TeamStore } from 'csuite-core';
import type { MemberStore } from '../src/members.js';

declare const store: TeamStore;
declare const members: MemberStore;

// Door 1 — authoring a preset. The wire cannot express one
// (`MemberPermissionListSchema`'s element type is `z.enum(PERMISSIONS)`),
// so a store method that writes one is authority with no way in.
// @ts-expect-error setPreset is not on the store: presets are read-only
store.setPreset('lead', ['members.manage'], 'admin');

// Door 2 — deleting one. Its own doc comment described a caller that
// would "gate destructive removal on an admin permission and surface
// the dependency to the operator". No such caller was ever written.
// @ts-expect-error deletePreset is not on the store
store.deletePreset('lead');

// Door 3 — the dependency scan that existed only to serve door 2.
// @ts-expect-error membersReferencingPreset is not on the store
store.membersReferencingPreset('lead', members);

// NOT A DOOR. `getPresets()` stays, and must: together with the preset
// branch of `resolvePermissions` it is what lets a database written
// before the flat leaf model load at all. If this line ever stops
// compiling, legacy brokers stop loading.
const presets = store.getPresets();
void presets;
