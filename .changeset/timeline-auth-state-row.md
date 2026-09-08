---
'csuite-web-ui': patch
---

The agent timeline renders `auth_state`. The kind was emitted by the runner,
stored by the broker and switched on in the timeline's default filter, and
`buildThread` had no case for it, so every row fell through and drew nothing.
Two facts died there: a runner blocked on a 401 retains its activity instead of
shipping it, which is why the feed goes quiet for a reason that has nothing to
do with the agent, and the retention queue is bounded, so `evictedEvents` counts
activity that is gone for good — the same class of loss as
`session_end.capture.dropped`. The row states both in words with their counts,
never as colour alone, and an `auth` chip joins the filter bar.
