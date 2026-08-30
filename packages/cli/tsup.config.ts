import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8')) as { version: string };

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: false,
  sourcemap: true,
  clean: true,
  target: 'node22',
  banner: { js: '#!/usr/bin/env node' },
  define: {
    __PKG_VERSION__: JSON.stringify(pkg.version),
  },
  // node-pty ships a native .node binding — keep it external so tsup
  // doesn't try to bundle the platform-specific prebuild.
  // The agent SDK is an optionalDependency, which tsup does not
  // auto-externalize the way it does dependencies — without this line
  // it bundles the SDK's JS into dist, and the lazy import would then
  // succeed even on a broker-only install where the package (and the
  // platform CLI it spawns) is deliberately absent.
  external: ['node-pty', '@anthropic-ai/claude-agent-sdk'],
});
