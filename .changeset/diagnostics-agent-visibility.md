---
'csuite-cli': minor
---

The `roster` tool now reports capture health and unresolved diagnostics on the
lines it already returns. The broker has computed `captureHealth`,
`diagnosticsUnresolved` and `diagnosticsRetention` on every roster response and
only the web UI read them, so an agent whose own verbatim capture had stopped
arriving had no surface that would tell it. A line gains `capture=<state>` and
`diagnostics=<n> unresolved, store <state>` only when the broker reports either
as unhealthy, and the tool description says what their absence is: a broker with
no opinion renders nothing, which is silence, not a clean bill.
