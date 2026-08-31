import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Keep the editor out of the entry chunk: the explorer is the landing
    // surface and should not pay for CodeMirror before you open a query tab.
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5173,
    // Reachable from outside the container when running under compose.
    host: true,
    proxy: {
      // Anchored and with the trailing slash, because Vite matches a proxy key
      // as a *prefix*: plain `/api` also captures `/apis`, which is one of the
      // app's own routes. That page was being handed to the backend, which
      // answered with the built index.html — so it 404'd on assets that only
      // exist after a production build, and the repo's own browser check has
      // been failing on it.
      // Under compose the API is a sibling service, not localhost.
      '^/api/': {
        target: process.env.FLINT_API_PROXY ?? 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
})
