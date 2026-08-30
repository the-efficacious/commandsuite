---
'csuite-sdk': minor
'csuite-cli': minor
'csuite-core': minor
'csuite-web-ui': minor
---

Add compatibility-preserving pending member creation. Callers can select
`credentialMode: 'pending'` to create a member without minting a bearer token;
the CLI, MCP tool, and web UI now use that mode and direct the new member through
device-code enrolment. Omitting the mode retains the 0.8 bootstrap-token response
until the legacy default is removed in a separately approved change.
