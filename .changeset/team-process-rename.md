---
'csuite-cli': minor
'csuite-core': minor
'csuite-sdk': minor
'csuite-server': minor
'csuite-web-ui': minor
---

**Breaking.** `process_document` is renamed `team_process` across the agent-facing surface, the wire, the SDK and storage. "Document" named the storage shape, not the concept: it framed the team's process as a static artifact to fetch rather than operational context to consult, and neither the permission leaf (`process.manage`) nor the store's own description had ever used the word. Bare `process` was not an option — it shadows Node's global and reads as the runtime process at every call site — and `team_process` rules that reading out on sight.

What moves:

- **MCP tools.** `process_document_get`, `process_document_history` and `process_document_write` become `team_process_get`, `team_process_history` and `team_process_write`. Only the new names are advertised in `tools/list`. The old names still dispatch for this one release, because tool names are quoted in prose that does not auto-update (team instructions, the team process text itself) and a hard rename would strand a caller reading them out of it; each such call logs a `warn` record naming the alias and its replacement so stale references can be found. The aliases are removed in the next minor.
- **REST.** `GET`/`PUT /process-document` and `GET /process-document/history` become `/team-process` and `/team-process/history`. The `GET /instructions` field `processDocument` becomes `teamProcess`, and the instruction-block kind `process_document` — in `blocks`, in instruction events and in the context watchdog's `context.block.kind` attribute — becomes `team_process`.
- **SDK.** The `ProcessDocument*` types and schemas become `TeamProcess*` (`TeamProcess`, `TeamProcessEdit`, `EditTeamProcessRequest`, `TEAM_PROCESS_MAX`, `TEAM_PROCESS_PATHS`, …), and `Client.getProcessDocument`, `processDocumentHistory` and `writeProcessDocument` become `getTeamProcess`, `teamProcessHistory` and `writeTeamProcess`. `csuite-core` now exports `createSqliteTeamProcessStore`, `TeamProcessStore` and `TeamProcessError`.
- **Permission.** `process.manage` becomes `team_process.manage`. There is no permissions migration: `raw_permissions` is stored verbatim and resolved on every read, and the resolver maps the old name to the new one, so a member or template saved under `process.manage` keeps the capability with no row rewritten. Both names are accepted on write.
- **Database.** The tables `process_document` and `process_document_edits` become `team_process` and `team_process_edits`. The store renames them in place on first open, deciding from `sqlite_master` rather than from a caught error: a fresh database gets the new names directly, a pre-rename database is renamed with every row — including the append-only edit history — preserved, and an already-migrated database is left untouched, so opening twice is the same as opening once.

Upgrade brokers and runners together. A runner built before this change validates the `GET /instructions` packet against a block-kind enum that has no `team_process` in it and rejects the whole response, so a new broker leaves an older runner unable to fetch its instructions at all — the same lockstep 0.9.0 asked for.

The instruction-version hash is computed from the same inputs as before, so upgrading does not mark any runner restart-pending.
