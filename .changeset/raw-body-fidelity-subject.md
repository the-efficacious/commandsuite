---
'csuite-core': patch
'csuite-server': patch
---

Correct what the raw-body store claims to preserve. `redact.ts` stated the
store "keeps bytes VERBATIM … captured before anything parses or redacts
them — that is what makes byte-exact reconstruction possible", and cited
`raw-body-store.ts`, which says the opposite. The code matches
`raw-body-store.ts`: for claude, attribute redaction runs in `parseOtlpLogs`
before the correlator captures anything.

Every fidelity claim on this path now names the object it is verbatim *with
respect to*, and states that the answer depends on the ingest route — codex
bundle uploads are content-addressed before any parse or redaction, claude
OTLP bodies are captured after attribute redaction. Four further statements
were corrected alongside the one first reported, including a field comment
inside `raw-body-store.ts` itself (`AppendBodyInput.bytes`, "The ORIGINAL
wire bytes") and two "before redaction" claims in `genai-correlator.ts` and
`run.ts`.

No behaviour change. The remaining gap — nothing in `raw_exchange` or
`raw_blob` records which route a body took, so a reader cannot tell a
scrubbed body from an unscrubbed one — is now stated in the prose rather
than left for a reader to discover, and is tracked separately.
