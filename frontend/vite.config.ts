import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': {
        // Aponta para o backend de desenvolvimento por padrão. A suíte e2e
        // (playwright.config.ts na raiz) sobe uma segunda instância do
        // backend numa porta própria e sobrescreve isto via env var, sem
        // interferir no ambiente de dev.
        target: process.env.VITE_API_PROXY_TARGET || 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
