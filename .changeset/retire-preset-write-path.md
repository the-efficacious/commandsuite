---
'csuite-core': patch
'csuite-sdk': patch
---

Permission presets are read-only compatibility, and the tree now says so.
`TeamStore.setPreset`, `TeamStore.deletePreset` and
`TeamStore.membersReferencingPreset` are removed. None had a production caller:
there is no REST route, CLI command, MCP tool or wizard that writes a preset,
and `MemberPermissionListSchema`'s element type is `z.enum(PERMISSIONS)`, so a
preset name is refused by the request schema before `resolvePermissions` is ever
reached. `deletePreset`'s own doc comment planned work for a caller that does
not exist.

`getPresets()` and the preset branch of `resolvePermissions` stay untouched.
Together they are the only reason a database written before the flat leaf model
still loads: a member row naming a preset resolves to leaves on every read, and
no row is rewritten.

Embedders calling the three removed methods are affected — they are exported on
`TeamStore` from `csuite-core`. Nothing else is: no route, command or tool
exposed them. `validatePermissionPreset` is kept as a published helper for
reading pre-consolidation data.

Four places described the write half as live and no longer do: the `POST
/members` comment in `app.ts`, `docs/dev/rest-api.mdx` on the instructions
packet and on `permissions`, and the SDK client's `getInstructions` doc.
`GET /team`'s row now says the deprecated `permissionPresets` field is not sent,
and `Team.permissionPresets`'s `@deprecated` note adds that no current server
writes one.
