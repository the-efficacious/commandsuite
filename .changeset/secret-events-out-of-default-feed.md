---
'csuite': minor
'csuite-cli': minor
'csuite-core': minor
'csuite-sdk': minor
'csuite-server': minor
'csuite-web-host': minor
'csuite-web-ui': minor
---

Stop secret lifecycle events leaking into every member's default history feed.

Secret events are pushed to an explicit recipient set — the members bound to the secret
plus every `secrets.manage` holder — and that part was already correct. But a fan-out push
persists `to_name = NULL`, and the default feed returns *every* `to_name IS NULL` row to
*every* viewer. So the live delivery was scoped and the durable readback was not.

Measured on the live broker before the fix: **27 of 27 secret events were returned to a
member who was neither bound to any of them nor held `secrets.manage`**, reachable with a
single `recent` call. The leaked body carries the secret slug, the environment variable
name, and which member it was bound to — not the value, which is never included.

`csuite-core` gains `SECRET_THREAD_PREFIX` and `isSecretThread`, and `matchesViewer` now
excludes `secret:`-tagged rows from the default feed. The SQLite feed query carries the
same exclusion so the two implementations answer the same question; each has a test
asserting it.

Excluded for every viewer rather than only for non-recipients, because the event log has
no access to secret bindings and should not grow one. Nothing is stranded: `GET /secrets`
returns per-viewer summaries and `GET /secrets/resolve` returns the caller's own env delta,
which is the surface built for this. The rows remain in the log for forensics; it is the
*feed* that stops carrying them. Live push behaviour is unchanged — the notification is
still the only signal that a runner restart is needed to pick a secret up.

Released as a minor under the repository's pre-1.0 convention: it removes rows a consumer
could previously read, which is behaviour-breaking for anyone who was reading them — and
anyone who was reading them was reading other members' secret metadata.

**Not fixed here, and it is larger than this.** The same `to_name IS NULL` feed also
returns objective discussion threads to members who are not the originator, assignee or a
watcher. Measured on the same broker: one objective's 31 thread messages are returned to a
member who is not on it. That is the same defect with a different tag, and it needs an
entitlement-aware feed rather than a prefix exclusion, because — unlike secrets — objective
threads have no alternative read surface today. Fixing it inside this change would have
made a bounded repair unbounded.

Also unaddressed: `EventLog.tail()` applies no viewer scoping at all. It currently has no
callers, so it is a latent hazard rather than a live leak.
