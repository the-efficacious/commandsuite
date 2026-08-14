---
'csuite-core': minor
'csuite-sdk': minor
'csuite-web-ui': minor
---

Read paths for captured data that was previously write-only: `GET /members/:name/telemetry` serves the cost and token records agents export, and `GET /members/:name/genai/:id/raw` serves the verbatim bytes behind an inference. The agent timeline now renders session start/end, so a run that dropped events says so instead of looking identical to a complete one, and unresolved capture diagnostics appear on the member profile.
