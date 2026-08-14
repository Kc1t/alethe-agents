// Proxy REST and WebSocket traffic to the single local Alethe Core authority.

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1422,
    // The core's Origin/Host allowlist only accepts 1422/1424. Falling back
    // to a different port would silently start a UI the core rejects on
    // every request instead of failing loudly at boot.
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:1423',
        ws: true,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('error', (_err, _req, res) => {
            if (
              res &&
              'writeHead' in res &&
              typeof res.writeHead === 'function' &&
              !res.headersSent
            ) {
              res.writeHead(503, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'Backend compilando ou iniciando...' }))
            }
          })
        },
      },
    },
    // Não vigie o backend Rust: o watcher do vite tenta observar
    // src-tauri/target/**/*.dll enquanto o linker ainda está escrevendo o
    // arquivo e estoura EBUSY, derrubando o dev server a cada rebuild do Rust.
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  build: {
    sourcemap: false,
    minify: 'terser',
    terserOptions: {
      compress: {
        drop_console: true,
        drop_debugger: true,
        passes: 2,
      },
      mangle: {
        toplevel: true,
      },
      format: {
        comments: false,
      },
    },
    rollupOptions: {
      output: {
        manualChunks: {
          xterm: ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-search'],
          react: ['react', 'react-dom'],
          mermaid: ['mermaid'],
          cytoscape: ['cytoscape'],
          markdown: ['react-markdown', 'remark-gfm'],
        },
      },
    },
  },
})
