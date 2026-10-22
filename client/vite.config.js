import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const target = process.env.API_URL || 'http://localhost:4000'

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Two copies of yjs in one bundle break `instanceof` checks and corrupt docs.
    dedupe: ['yjs', 'lib0', 'y-protocols', 'y-prosemirror'],
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target, changeOrigin: true },
      '/sync': { target: target.replace(/^http/, 'ws'), ws: true },
    },
  },
})
