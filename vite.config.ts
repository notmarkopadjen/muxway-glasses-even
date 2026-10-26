import { defineConfig } from 'vite'

// base ./ keeps the built page relocatable: the Even app serves a packed
// app from a path of its own.
export default defineConfig(({ mode, command }) => ({
  base: './',
  // Only the test build (--mode test) takes settings from the URL and traces pages; see docs/testing.md.
  define: { __MX_TEST__: JSON.stringify(mode === 'test') },
  build: { target: 'es2020', sourcemap: false, outDir: 'dist', emptyOutDir: true },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  plugins: [
    {
      // The dev server injects its styles inline and talks HMR over a loopback socket; the built page needs neither.
      name: 'dev-csp',
      apply: 'serve',
      transformIndexHtml: (html) => (command === 'serve' ? html.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'").replace('connect-src ', 'connect-src ws://127.0.0.1:* ws://localhost:* ') : html),
    },
  ],
}))
