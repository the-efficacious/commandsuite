---
'csuite-cli': patch
---

The `fs_*` MCP tool descriptions no longer tell agents that objective namespaces are broken.

Six descriptions — `fs_ls`, `fs_stat`, `fs_read`, `fs_write`, `fs_mkdir`, `fs_mv` — carried `KNOWN DEFECT` notices stating that operations under `/objectives/<id>/` fail, misreport their result, or must not be retried, and instructing agents to write to their home instead. **Those defects were fixed in 0.3.1, and the notices shipped in the same artifact as the fix**, so the published package documented its own working feature as broken.

All six claims were re-verified against a live broker before removal, as a non-director member rather than a director: `fs_write`, `fs_mkdir`, `fs_mv`, `fs_ls`, `fs_stat`, and `fs_read` all succeed under `/objectives/<id>/` and report honestly. The descriptions now state the real rule — these operations work for members of the objective and for directors, and the entries are owned by `obj:<id>` rather than by a member.

A tool description is a **specification**: it sits in every agent's context and is the only spec an agent has for a tool whose source it cannot read. A wrong one is not a documentation nit, it is the tool being wrong for every caller at once. The measured cost here was not only the deflected work — a teammate routed evidence around the namespace on the doc's instruction, then read a genuine unrelated defect as the documented one, because the text had pre-loaded a wrong explanation. **A stale "known defect" notice also consumes the signal from the next real failure.**

`fs_ls` gains a note about a limit that *is* live: it renders directories with a trailing slash (`/you/notes/`) while paths are stored without one and the API rejects a trailing slash, so the listing's own output is not valid input to the next call. Documented until that is fixed rather than left for the next caller to rediscover.

Guarded by a test that fails if any of the phrases returns, matched over the whole tool JSON rather than the top-level description — `fs_write` carried its notice on a nested property, which a top-level check would have missed. The test asserts the positive half too, so deleting every mention of objective namespaces does not pass. It is a guard against re-introduction, not a proof of accuracy; the behaviour it now claims is established in `apps/server/test/files/objective-namespace.test.ts`.
