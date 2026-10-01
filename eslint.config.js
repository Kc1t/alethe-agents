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
    // Plugin examples are plain scripts that run in the webview and reach Alethe via window.alethe.
    files: ['docs/examples/**/*.js'],
    languageOptions: { globals: { ...globals.browser } },
  },
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
      // Terminal app: regexes match ANSI/control sequences (, …) on purpose,
      // so the rule is only a false positive here.
      'no-control-regex': 'off',
      // Hooks: the hard rule stays an error (a real bug), dependencies stay a warning.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // Deterministic import/export order (autofix).
      'simple-import-sort/imports': 'warn',
      'simple-import-sort/exports': 'warn',
      // Type strictness: warn for now (the `any`s are part of the store migration).
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      // All backend IPC goes through a lib wrapper (tauri.ts / spotify.ts), never a raw invoke()
      // in a component, store or hook (project convention).
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@tauri-apps/api/core',
              importNames: ['invoke'],
              message: 'Use the functions in lib/tauri.ts or lib/api instead of a raw invoke().',
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
    // Tests: relax rules that get in the way of setup and mocks.
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
