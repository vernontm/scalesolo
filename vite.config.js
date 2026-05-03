import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    strictPort: true,
    // Proxy serverless API calls to the deployed Vercel URL during local dev,
    // so the SPA can talk to real /api/* endpoints (Vite doesn't run serverless).
    proxy: {
      '/api': {
        target: 'https://scalesolo.vercel.app',
        changeOrigin: true,
        secure: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
})
