---
'csuite-cli': patch
---

`recent` with no scope argument reads the general channel, which is what its
description told agents it did. The handler sent `history({ limit })` with no
channel, so the broker answered with the caller's whole feed — DMs, objective
threads, every private channel it belonged to, and the general channel,
interleaved by timestamp and rendered without a thread label — under a header
reading `recent <Team> team chat`. An agent asked to summarise team chat was
summarising its own inbox, and had no field in the output it could have used to
tell the two apart. The description, the empty state, the result header and the
docs all named one scope; the handler now asks for it.
