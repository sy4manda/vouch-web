import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const shared = fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url))

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  envDir: '../..', // one .env at the repo root, shared with the server
  resolve: { alias: { '@vouch/shared': shared } },
  server: { fs: { allow: ['../..'] } }, // the dev server may read packages/shared
})
