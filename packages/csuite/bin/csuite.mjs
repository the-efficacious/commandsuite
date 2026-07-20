#!/usr/bin/env node
// Thin re-entry to csuite-cli so the bin gets linked on
// `npm install -g csuite`. npm only links bins declared on the
// top-level package being installed, not on its transitive deps, so a
// meta-package without its own `bin` entries wouldn't expose anything.
await import('csuite-cli');
