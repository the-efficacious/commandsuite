---
'csuite-server': patch
'csuite-cli': patch
---

Release builds now print a clean version. `csuite --version` on a published release
reports `0.10.0` rather than `0.10.0+main.<fingerprint>`; unreleased and local builds
keep the fingerprint, which is the only place it distinguishes anything.

The version string already branched on build source. The branch never ran: Turbo executes
tasks in strict env mode, so `CSUITE_BUILD_SOURCE` — set by `scripts/publish-gate.mjs`
immediately before publication — was dropped before tsup could see it, because the build
task did not declare it. Every release up to and including 0.9.0 shipped baked as a `main`
build while the gate that sets the flag appeared to work.
