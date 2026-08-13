import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8')) as { version: string };

export default defineConfig({
  entry: { index: 'src/index.ts', 'conformance/index': 'src/conformance/index.ts' },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ['vitest'],
  target: 'node22',
  define: {
    __PKG_VERSION__: JSON.stringify(pkg.version),
  },
});
