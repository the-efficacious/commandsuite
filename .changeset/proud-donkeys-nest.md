---
'csuite-server': minor
'csuite-cli': minor
---

Fresh bootstraps now seed into a dedicated `./csuite/` server directory instead of scattering files across the cwd.

`csuite setup` and the `csuite serve` first-run wizard create `./csuite/` (mode `0o700` — the containing-directory permission the KEK docs always recommended) and place `csuite.json`, `csuite.db`, and `csuite-kek.bin` inside it. Resolution never nests and stays backward compatible: an explicit `--config-path`/`$CSUITE_CONFIG_PATH` wins, a flat `./csuite.json` in the cwd marks it as the server directory (existing deployments and running from inside `./csuite/` both keep working unchanged), and `csuite serve` from the parent auto-discovers `./csuite/csuite.json`.

Also fixed: a boot that bails before the wizard can run (non-TTY stdin, already-populated team) no longer leaves a freshly-minted `csuite-kek.bin` — or anything else — behind in the directory.
