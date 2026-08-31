---
'csuite-core': patch
'csuite-server': patch
---

Make unknown, unverified, and disabled webhook endpoints indistinguishable to
unauthenticated senders. Correctly signed requests to disabled endpoints now
leave a causal rejected receipt for authorized operators.
