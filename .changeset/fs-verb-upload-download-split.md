---
'csuite-cli': patch
---

`fs_write` no longer describes itself as uploading a file. It writes from inline content that travels through the tool call and into the agent's context; `fs_upload` and `fs_download` are the pair that streams between the runner's disk and the broker without the bytes entering an IPC frame or a tool result, and that difference is the reason both exist.
