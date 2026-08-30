---
"csuite-cli": minor
---

`csuite setup --non-interactive --team <name> --member <name> --token-file <path> [--totp-secret-file <path>]` seeds a team and its first member with no TTY. The bearer token is written to the file at mode 0600 and never printed; a TOTP secret is generated and enrolled only when a file for it is given. Provisioning scripts, container entrypoints and CI jobs can now bring up a broker without a human at a terminal (#198).
