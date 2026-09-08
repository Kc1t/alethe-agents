// Proxy REST and WebSocket traffic to the single local Alethe Core authority.

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    // `scripts/dev-instance.mjs` (the `npm run app` entry point) picks a free
    // port per checkout and passes it here so Vite and Tauri's `devUrl`
    // always agree; running Vite directly (`npm run dev`) still defaults to
    // 1422.
    port: Number(process.env.ALETHE_DEV_PORT) || 1422,
    // Bind one loopback stack explicitly. Left to `localhost`, Vite resolves `::1` first on
    // Windows while the port scan in `dev-instance.mjs` checks IPv4 — the scan then calls a port
    // free that Vite cannot bind, and `npm run app` dies on "Port already in use". Naming the
    // address here removes the whole class of mismatch rather than one instance of it.
    host: '127.0.0.1',
    // Keeps the dev UI's port predictable once chosen (referenced by the
    // storage-identity contract test) instead of silently drifting to
    // another one if it's somehow taken after `dev-instance.mjs` already
    // picked it.
    strictPort: true,
    proxy: {
      '/api': {
        // ALETHE_SERVER_PORT lets the standalone/Web-mode core (see
        // `bind_server_listener` in server_main/mod.rs) be pinned to a
        // specific port when 1423 is already taken by another Alethe.
        target: `http://127.0.0.1:${process.env.ALETHE_SERVER_PORT || '1423'}`,
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
