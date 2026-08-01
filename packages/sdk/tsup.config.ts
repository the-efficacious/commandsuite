import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    types: 'src/types.ts',
    schemas: 'src/schemas.ts',
    protocol: 'src/protocol.ts',
    client: 'src/client.ts',
    'text-metrics': 'src/text-metrics.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node22',
});
