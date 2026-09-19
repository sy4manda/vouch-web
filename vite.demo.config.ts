// Builds the whole app, in demo mode, into one self-contained HTML file: npm run build:demo
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

const stub = fileURLToPath(new URL('./demo/stubs.ts', import.meta.url));
const stubbed: Plugin = {
  name: 'demo-stubs',
  enforce: 'pre',
  resolveId(source) {
    if (/\/(httpApi|privyAuth|fonts)$/.test(source)) return stub;
  },
};

export default defineConfig({
  mode: 'demo',
  plugins: [stubbed, react(), viteSingleFile()],
  build: { outDir: 'dist-demo', emptyOutDir: true },
});
