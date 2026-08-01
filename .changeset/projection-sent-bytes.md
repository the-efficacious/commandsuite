---
'csuite-server': patch
'csuite-cli': patch
---

The context watchdog projects the process document's sent bytes rather
than a normalised copy, and the runner's design comment no longer
states the opposite of the shipped behaviour.

Both were raised on #130 and crossed with its merge, so 0.4.0 carries
them.

- **The projection trimmed the document; the runner does not.** The
  store refuses only text whose *trimmed* value is empty — it does not
  normalise valid text — so `"  rule\n"` is a legal document rendered
  verbatim, while the projection carried `"rule"`. The redaction
  exemption and any resend then held bytes the agent never received.

  Trimming to ask "is this empty" and trimming to ask "is this the same
  block" are different questions sharing a function. The first is
  validation and is correct; the second creates a second representation
  of the value, and the moment two exist a recovery hands back
  something that was never sent. The guard still mirrors the store's
  invariant, but it now decides *whether* to project, never *what*.

- **A KNOWN GAP comment survived the closing of its own gap.**
  `fixed-context.ts` still said the watchdog does not watch this block
  and that a lost document returns only at the next runner start. #130
  made the opposite true, so the file's primary design comment
  described the absence of a feature it ships. The concepts page and
  the MCP reference carried the same claim.

Also states a behaviour the docs previously denied: because the
projection is built from the *current* stored document, an agent
holding a superseded version does not contain the current one — so an
edit reaches a running session, classified as stale rather than merely
missing when the prior text is known. Codex remains the exception, its
system projection being unobservable (#118).
