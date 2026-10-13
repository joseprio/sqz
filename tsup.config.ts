import { cpSync } from 'node:fs';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', node: 'src/node/index.ts', cli: 'src/cli.ts', worker: 'src/node/worker.ts' },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  dts: { entry: { index: 'src/index.ts' } },
  clean: true,
  // sqz's own codecs (src/wasm) locate their .wasm via import.meta.url, so they ship as
  // separate files in dist/wasm/ instead of being bundled.
  external: [/\/wasm\/sqz_[a-z_]+\.js$/],
  async onSuccess() {
    cpSync('src/wasm', 'dist/wasm', { recursive: true, filter: (f) => !f.endsWith('.d.ts') });
  },
  splitting: true,
  sourcemap: false,
});
