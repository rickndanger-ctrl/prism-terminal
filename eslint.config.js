import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['coverage/', 'dist/', 'node_modules/'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['scripts/probe-gemini-attention.mjs', 'scripts/probe-gemini-session-host.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', AbortController: 'readonly',
        WebSocket: 'readonly', Buffer: 'readonly' },
    },
  },
);
