---
'csuite-web-ui': patch
---

The web UI stopped labelling two unrelated subsystems "Notifications" one
screen apart. The nav item is now "External notifications" — the inbound
webhook registry, gated on `notifications.manage` — while the Account section
keeps "Notifications" for web push to this browser, which is gated on nothing.
A member who cannot see the nav item can still toggle push, and the two labels
now say so. The blocked-push badge names push explicitly for the same reason.
