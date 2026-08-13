---
'csuite-web-ui': patch
---

Redesign the objectives UI around how the work actually reads. The
list is now a grouped ledger: live work on top (blocked first, sorted
by last activity, with per-row age and unread-post badges), closed
work collapsed behind a disclosure, an All/Mine filter, and a header
that counts live work instead of the whole record. The detail page
drops its five tabs for one page: the outcome leads, and once the
objective is done it pairs side-by-side with the result — the result
card carrying the view's one gold assert bar. Lifecycle events and
discussion now merge into a single chronological thread with humanized
event lines instead of a raw JSON audit log. Actions are verbs in the
header: completing opens the result editor next to the outcome it
answers, blocking no longer demands a reason (matching the server),
and cancelling takes a second explicit press. Trace review stays
admin-only behind a disclosure. All three objective views now sit on
the same page measure as the rest of the product — the ledger at the
panel measure, the detail and create form at the record measure.
