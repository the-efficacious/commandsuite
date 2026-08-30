---
"csuite-cli": minor
---

`@anthropic-ai/claude-agent-sdk` is now an optional dependency. A default install (npm and pnpm install optional dependencies by default) is unchanged: `csuite claude` works as before. A broker-only install (`--omit=optional` / `--no-optional`) drops the ~263 MB agent SDK; every broker-side verb works without it, `csuite claude` fails fast with a one-line message naming the missing package and how to install it, and `csuite <runner> --doctor` reports the agent binary as "absent by design" (advisory) instead of FAIL.
