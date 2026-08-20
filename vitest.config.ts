import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
    // Node 22+ ships its own experimental global `localStorage`, which shadows
    // jsdom's implementation entirely (window.localStorage ends up undefined
    // too) unless disabled. Without this, any test touching localStorage fails
    // with "Cannot read properties of undefined".
    env: { NODE_OPTIONS: '--no-experimental-webstorage' },
  },
})
