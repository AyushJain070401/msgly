// Flat config. ESLint 9 dropped `.eslintrc.json`, and flat config resolves from
// the nearest ancestor of the working directory — which is why one file at the
// root still covers every package running `eslint src` in its own folder.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Replaces the old `ignorePatterns`. Build output and the CommonJS shims
    // tsup emits are generated, not authored.
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.cjs', 'site/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        // The adapters target Node 20+ and use fetch, crypto and the timer
        // functions. Declared explicitly rather than pulling in `globals` for
        // one short list.
        console: 'readonly',
        fetch: 'readonly',
        globalThis: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        queueMicrotask: 'readonly',
        structuredClone: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        Buffer: 'readonly',
        crypto: 'readonly',
        btoa: 'readonly',
        atob: 'readonly',
        Response: 'readonly',
        Request: 'readonly',
        Headers: 'readonly',
        FormData: 'readonly',
        Blob: 'readonly',
        File: 'readonly',
        ReadableStream: 'readonly',
      },
    },
    rules: {
      // An argument or binding named with a leading underscore is a deliberate
      // "this exists but is unused" — the unimplemented `uploadMedia` hooks
      // every adapter carries, for one.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'no-console': 'off',
    },
  },
);
