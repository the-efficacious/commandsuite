---
'csuite-core': patch
---

Stop a handful of wrong sign-in codes locking every member out of the web UI. Codeless login counted failures in one global bucket, so ten bad guesses from anywhere blocked the whole team for fifteen minutes. Failures are now counted per source first — the guesser locks themselves out — and reaching the global ceiling asks for a member name instead of refusing everyone.
