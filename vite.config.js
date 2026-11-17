import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (/node_modules\/(?:@codemirror|@lezer|style-mod|w3c-keyname|crelt)\//.test(id)) return 'editor'
          if (/node_modules\/(?:yjs|y-protocols|y-websocket|lib0)\//.test(id)) return 'collaboration'
          if (/node_modules\/(?:marked|dompurify)\//.test(id)) return 'markdown'
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:3000',
      '/auth': 'http://127.0.0.1:3000',
      '/uploads': 'http://127.0.0.1:3000',
      '/collaboration': { target: 'ws://127.0.0.1:3000', ws: true },
    },
  },
})
