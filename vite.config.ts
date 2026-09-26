import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    // Sem host explícito o vite escolhe ::1 ou 127.0.0.1 por sorte da resolução
    // de "localhost", e a webview fica na família errada: tela branca.
    host: '127.0.0.1',
    port: 1422,
    strictPort: true,
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
