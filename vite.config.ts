import { defineConfig } from 'vite'

// base ./ keeps the built page relocatable: the Even app serves a packed
// app from a path of its own.
export default defineConfig(({ mode }) => ({
  base: './',
  // Only the test build (--mode test) takes settings from the URL and traces pages; see docs/testing.md.
  define: { __MX_TEST__: JSON.stringify(mode === 'test') },
  build: { target: 'es2020', sourcemap: false, outDir: 'dist', emptyOutDir: true },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
}))
