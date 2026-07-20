#!/usr/bin/env node
// Thin re-entry to csuite-server's bin entry so the binary gets
// linked on `npm install -g csuite`. Imports the bin subpath
// explicitly (the package's root export is the library entry).
await import('csuite-server/bin');
