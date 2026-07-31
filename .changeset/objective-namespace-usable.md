---
'csuite': patch
'csuite-cli': patch
'csuite-core': patch
'csuite-sdk': patch
'csuite-server': patch
'csuite-web-host': patch
'csuite-web-ui': patch
---

Make objective namespaces usable: fix `FsEntry.owner` and the `list()` authorization gate.

Two defects, both live since objective namespaces shipped, and both needed for the feature
to work at all.

**1. `FsEntrySchema.owner` was `NameSchema`.** Objective-namespace entries carry
`owner = 'obj:<id>'` (`OBJECTIVE_OWNER_PREFIX`, `files/paths.ts`), and `NameSchema`'s
pattern excludes `:`. So every namespace entry failed the schema that ships alongside the
code producing it.

The failure mode is the part worth remembering: **validation runs on the response, after
the write has committed.** `fs_write` and `fs_mkdir` reported an error for work that had
already succeeded — an agent that retried hit a collision on a file it was told it never
wrote, and one that gave up left a file it did not know existed. `fs_rm` alone appeared to
work throughout, because it returns void and parses nothing. The only namespace operation
an agent could complete and be told the truth about was the destructive one.

`owner` is now `FsOwnerSchema` — a member name **or** `obj:<objective-id>`. Widened rather
than changing the producer: `obj:<id>` is part of the shipped authorization model, not a
malformed name. That is the opposite call from `Broker.push`, where nothing legitimate
produced the rejected value and the producer moved instead.

**2. `list()` gated on `members.manage || ownsPath` and never called `canRead()`.** A
namespace is owned by `obj:<id>` and by no member, so an ownership test refused every
member of the objective — including its assignee. `stat`, `read` and `listShared` all
gated on `canRead`, which already resolves objective membership and grants; `list` was the
one that did not. This is why `fs_ls /objectives/<id>` returned 403 to the person the
namespace was created for, and why the whole thing read as a permissions problem rather
than two unrelated bugs.

Non-members are still refused. The fix widens who may list, not whether listing is gated.

The contract test that pinned defect 1 as a KNOWN DIVERGENCE with an inverted assertion has
been converted to an ordinary `expectMatchesContract()` case, which is exactly what that
inversion existed to force. A source comment in `runtime/tools.ts` describing both defects
as live has been rewritten to describe current behaviour — a comment that contradicts the
code is a defect in its own right.

Released as a patch: it removes restrictions rather than adding them, and no caller that
previously succeeded now fails.
