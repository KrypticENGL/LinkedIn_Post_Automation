import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Forwards to the Express server from src/server.ts (npm run dev at the repo
    // root) so the same fetch("/api/...") calls work in local dev as in production,
    // with no CORS setup needed.
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
})
