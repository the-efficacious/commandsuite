---
'csuite-sdk': minor
'csuite-core': minor
'csuite-server': minor
---

Add the runner-to-broker message disposition protocol and durable 24-hour
pending ledger. Notification receipts now wait for a subscriber acknowledgement
instead of claiming delivery when a live socket merely accepted bytes; old
runners remain explicitly unreported.
