import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import simpleImportSort from 'eslint-plugin-simple-import-sort'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'dist',
      'node_modules',
      'src-tauri',
      'graphify-out',
      '.claude',
      'target-e2e',
      '**/.wrangler',
      'scripts',
      'tests',
      '*.config.js',
      '*.config.ts',
      'vite.config.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      'simple-import-sort': simpleImportSort,
    },
    rules: {
      // Terminal app: these regexes intentionally match ANSI/control sequences.
      'no-control-regex': 'off',
      // Hooks: rule violations are errors; dependency advice remains a warning.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // Deterministic import/export ordering (autofixable).
      'simple-import-sort/imports': 'warn',
      'simple-import-sort/exports': 'warn',
      // Type strictness remains a warning while the store migration still contains `any`.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      // Backend IPC goes through a library wrapper, never raw invoke() in UI or stores.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@tauri-apps/api/core',
              importNames: ['invoke'],
              message: 'Use the lib/tauri API wrappers instead of raw invoke().',
            },
          ],
        },
      ],
    },
  },
  {
    // IPC wrappers are the only modules allowed to call invoke() directly.
    files: ['src/lib/tauri/**', 'src/lib/api/**', 'src/lib/spotify.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    // Tests relax rules that interfere with setup and mocks.
    files: ['**/*.test.{ts,tsx}'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  {
    // Rendezvous smoke tests run in Node with its built-in Web APIs enabled.
    files: ['services/rendezvous-cloudflare/test/**/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  prettier,
)
