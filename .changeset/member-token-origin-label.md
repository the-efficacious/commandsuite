---
'csuite-web-ui': patch
---

The revoke-token confirmation names a token's origin the way the row above it
does. The badge showed the display label (`config-file` / `rotated` /
`device-code`) while the dialog interpolated the raw `TokenOrigin` wire value
(`bootstrap` / `rotate` / `enroll`), so the reader's one chance to check they
were about to kill the right credential described it in a vocabulary nothing
else on the page used.
