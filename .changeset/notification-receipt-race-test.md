---
'csuite-core': patch
---

Pin the #263 property: a push into a live, ack-capable subscription that never
settles reports `pending`, never `settled`. `settled` is the only input a
notification receipt turns into `delivered`, so this is the assertion that stops
a receipt claiming a delivery nothing acknowledged.
