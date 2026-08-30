import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';
import { sourceFingerprint } from '../../scripts/source-fingerprint.mjs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8')) as { version: string };
const buildSource = process.env.CSUITE_BUILD_SOURCE === 'npm' ? 'npm' : 'main';
const fingerprint = sourceFingerprint('../..');

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
    __BUILD_SOURCE__: JSON.stringify(buildSource),
    __SOURCE_FINGERPRINT__: JSON.stringify(fingerprint),
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
