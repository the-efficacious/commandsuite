---
'csuite-cli': patch
---

`csuite objectives update --note` is gone. The flag was advertised in the usage
block, parsed, and forwarded on the payload, where the broker dropped it: `note`
is read only as handover context for an assignee change, and `update` cannot
change the assignee. Passed on its own it earned a 400 from a schema that wants
one of status / blockReason / assignee / watchers; passed beside `--status` it
vanished in silence. Either way an operator's note went nowhere and nothing said
so. `--note` now reaches the wire on `reassign` alone, where it is recorded on
the `reassigned` event.
