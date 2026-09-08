---
'csuite-sdk': patch
---

Doc-comment correction, no behaviour change. `InstructionBlockKind`'s comment
(which ships in the published `.d.ts`, so it is what an SDK consumer reads)
justified pinning the block-kind strings on "`persistent_context kind="…"`
re-sends, the context watchdog's `context.block.kind` attribute". Neither
exists: both context watchdogs were removed in #185, deliberately and on
measured grounds, and no module, frame or attribute by those names is anywhere
in the tree.

The pinning rule is unchanged and now cites the live wire it actually rests on —
`blocks[].kind` on `GET /instructions`, and `changed` on the
`kind: 'instructions'` channel event, both of which are covered by tests. Four
source comments in `csuite-core` and `csuite-cli` and one line of
`docs/dev/trace-pipeline.mdx` described the watchdog as shipped and no longer
do; `instructionCaptureExemptions` is stated as what it is today, a redaction
scope that keeps operator-authored prose readable in stored captures.
