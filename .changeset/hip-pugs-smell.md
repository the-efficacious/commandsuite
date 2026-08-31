---
'csuite-server': patch
'csuite-core': patch
---

Declare `Vary: Accept` on both representations of the paths the web UI and
REST API share, and mark API responses `no-store`.

A browser navigation to `/objectives` is answered with the SPA shell while an
API call to the same URL is answered with JSON, and neither response said it
had varied on `Accept`. A cache is entitled to reuse the first for the second,
which is what happened: refreshing an objective page cached the shell under
that URL, the app's own fetch of the same URL was served that HTML, and the
page rendered `invalid JSON from …`. Because the objectives fetch lives in the
shell, one refresh degraded every route in the session until the entry expired.

Operators behind a CDN: `Vary: Accept` fixes the cache key going forward but
does not evict entries already stored under the unvaried response. Purge the
cache for HTML-negotiated origin paths after upgrading, or the symptom will
survive the fix and look like the fix failed.

API responses now also carry `Cache-Control: no-store`. RFC 9111 §3.5 already
stops a shared cache storing a response to an `Authorization`-bearing request,
but browser sessions authenticate with a cookie and get no such protection.
