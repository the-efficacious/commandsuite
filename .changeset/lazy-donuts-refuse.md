---
'csuite-server': minor
'csuite-cli': minor
---

Remove both context watchdogs; re-assert the plate on codex compaction
instead.

The broker no longer scans captured LLM traffic to police what is in an
agent's context. Both enforcement loops are gone: the objective-id
reminder ("You have N active objective(s) that are no longer in your
context…") and the instruction-block presence check with its
"persistent context restored" resends. Measured across two live teams,
97% of the reminder pushes went to members whose captures the detector
could not reliably read — re-injecting full contract text at agents
that were actively working the very objective named in the push —
while the runner's once-per-session `context_refresh` re-brief never
misfired. The re-brief is now the whole awareness story: session
start, and after a compaction.

- The codex runner now observes `contextCompaction` items —
  including auto-compactions codex decides on by itself, which were
  previously logged and dropped — and fires the same
  `context_refresh` re-brief the claude runner fires from its
  SessionStart(compact) hook. `RunnerHandle` gains `rebrief()` for
  adapters whose frameworks report compaction through their own
  channels.
- Correlator exchanges dropped from correlation (stale eviction,
  pending-cap displacement) now carry their own point diagnostic,
  `correlator.pending_exchange_dropped`, instead of piggybacking on
  the watchdog's check-unavailable incident. The retired `context.*`
  diagnostic causes are swept from unresolved health state at broker
  start so an old incident cannot latch forever with no mechanism
  left to clear it.
