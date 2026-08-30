---
"csuite-cli": patch
---

`csuite enroll` prints the new TOTP secret and otpauth URI before attempting the QR code, and a QR rendering failure is reported instead of killing the command. Previously the broker had already rotated the member's secret when the QR renderer crashed (`Dynamic require of "module" is not supported` in the ESM build), so the secret was never shown and the member was locked out of the web UI (#212).
