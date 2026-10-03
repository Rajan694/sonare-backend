import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist', 'coverage', 'node_modules', 'drizzle'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: globals.node },
    rules: {
      // About 60 `any`s predate linting; new code should not add more.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      // `declare global { namespace Express }` is how Express's Request type is extended.
      '@typescript-eslint/no-namespace': ['error', { allowDeclarations: true }],
      // Best-effort cleanups (closing a stream, a cache write) deliberately ignore failures.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  prettier,
);
