---
'csuite-core': patch
---

Stop storing the body of webhook deliveries that fail signature verification, and bound the deliveries table. `/hooks/:slug` is unauthenticated by design, so retaining rejected payloads let anyone who knew a slug write unbounded data into the broker database. Rejections now record size, digest and reason instead of the payload, cannot be replayed, and each endpoint keeps its most recent 1000 receipts.
