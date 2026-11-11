import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const backend = process.env.CLIPFORGE_BACKEND || 'http://127.0.0.1:3001'

// Dev: the UI calls /api and /media on its own origin and Vite proxies them to the backend.
// Production: `npm run build` → the backend serves frontend/dist on http://localhost:3001.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': { target: backend, changeOrigin: false },
      '/media': { target: backend, changeOrigin: false },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.js'],
    css: false,
  },
})
