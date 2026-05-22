import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import type { ProxyOptions } from 'vite'

// Backend API (siempre 3001). El frontend puede usar 5173, 5174, etc.
const API_TARGET = 'http://127.0.0.1:3001'

function proxyApi(path: string): ProxyOptions {
  return {
    target: API_TARGET,
    changeOrigin: true,
    configure(proxy) {
      proxy.on('proxyReq', (_proxyReq, req) => {
        console.log(`[vite-proxy] ${req.method ?? '?'} ${path} → ${API_TARGET}`)
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': proxyApi('/api'),
      '/health': proxyApi('/health'),
    },
  },
})
