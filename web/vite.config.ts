import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
  worker: { format: 'es' },
  // jSquash locates its .wasm with import.meta.url, which pre-bundling would break.
  optimizeDeps: { exclude: ['@jsquash/webp', '@jsquash/jpeg', '@jsquash/avif'] },
});
