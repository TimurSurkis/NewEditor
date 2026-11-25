import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/**', 'out/**', 'dist/**', 'test-results/**', 'playwright-report/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', URL: 'readonly' } },
  },
  {
    files: ['tests/electron/*.mjs'],
    languageOptions: {
      globals: {
        window: 'readonly',
        location: 'readonly',
        document: 'readonly',
        NodeFilter: 'readonly',
        Event: 'readonly',
        requestAnimationFrame: 'readonly',
        performance: 'readonly',
      },
    },
  },
);
