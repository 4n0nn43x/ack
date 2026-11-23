import { defineConfig } from 'vite'

export default defineConfig({
  base: './', // relative asset paths, so the packaged .ehpk works wherever the Even app serves it
  server: { host: true, port: 5173 },
  build: { target: 'esnext', chunkSizeWarningLimit: 1600 },
})
