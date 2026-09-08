---
'csuite-core': minor
'csuite-sdk': minor
'csuite-web-ui': minor
---

**Breaking.** Query parameters are `snake_case`, and a paging cursor now states its direction in its name. The composite cursor splits by direction — `before_ts` / `before_id` on `GET /members/:name/activity`, which walks newest-first, and `after_ts` / `after_id` on `GET /members/:name/genai` and `GET /members/:name/telemetry`, which walk oldest-first. `GET /notifications/endpoints/:slug/deliveries` renames its scalar bound `before` → `before_ts`, so its arity is visible next to the composite one. The four camelCase survivors become `stalled_ms` (`GET /team/status`), `client_kind` / `client_version` (`GET /subscribe`) and `parent_origin` (`GET /setup/connect-platform`), matching the `if_offline` ↔ `ifOffline` ↔ `--if-offline` projection the rest of the wire already follows.

This ends a defect, not just a spelling. `cursor_ts` / `cursor_id` mapped to `before: {ts, id}` on the activity read and to `after: {ts, id}` on telemetry and gen-AI — the same two parameter names paging in **opposite directions** on sibling endpoints, with the REST reference asserting they were "the same composite cursor". A client that reused the activity paging loop against `/telemetry` fed the newest row back into a forward walk and never terminated. The two store directions are both correct and are unchanged; only the wire grammar moves.

**Compatibility window — one release.** Every retired spelling is still accepted, prefers the current name when both are sent, and answers with `Deprecation: true` plus `X-CSuite-Deprecated-Query: <legacy>=<current>` naming exactly what to change; the response body is identical either way, and the broker logs a warn line per stale request so a fleet's remaining callers are findable. **These aliases are removed in the next minor** — `cursor_ts`, `cursor_id`, `before` (on deliveries), `stalledMs`, `clientKind`, `clientVersion` and `parentOrigin`.

SDK: `Client.listNotificationDeliveries`'s `before` option is now `beforeTs`, and `NotificationsStore.listDeliveries` takes `beforeTs`. The `cursor` fields on `ListActivityQuery`, `ListGenaiQuery` and `ListTelemetryQuery` are unchanged — the client sends the right wire name for each endpoint's direction.
