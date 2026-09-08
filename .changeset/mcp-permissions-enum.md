---
'csuite-cli': patch
---

The MCP `permissions` input on `members_add` and `members_update` now carries an `enum` of the permission leaves, so an agent reads the controlled vocabulary out of the tool schema instead of guessing a leaf name and learning the real spelling from the broker's rejection message.
