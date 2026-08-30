---
"csuite-web-ui": patch
---

Opening a DM no longer opens the other member's activity stream unless the viewer may read it (`activity.read`, or their own) — the right-rail inspector renders "Restricted" instead of a 403 handshake retried forever (#214). The Files root view lists `/` instead of sending an empty path and rendering "400" (#216). The notifications pages no longer fetch endpoints, profiles or deliveries before rendering their own "Restricted" refusal, so a member without `notifications.manage` produces no 403s.
