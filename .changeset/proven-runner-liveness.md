---
'csuite-sdk': minor
'csuite-core': minor
'csuite-server': minor
'csuite-cli': minor
'csuite-web-ui': minor
---

Make runner liveness evidence-based and message delivery recoverable. Runners
report typed ready/degraded conditions, action-only turn outcomes, and an
explicit supervision claim; old peers remain unreported. Messages become
subscription-owned accepted leases at real turn start and return to pending on
disconnect or any degraded projection, while stale completions are refused.

0.9.0 is the protocol compatibility baseline. Upgrade brokers and runners
together from 0.8.x; mixed 0.8.x/0.9.0 deployments are unsupported.
