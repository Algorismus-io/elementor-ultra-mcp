// @ts-check
// Flat ESLint config (Engineering Standards §2.3).
// typescript-eslint recommendedTypeChecked, pointed at both package tsconfigs,
// bans `any`, and requires a justification comment on every inline disable.
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Not linted: build output, deps, vendored sources, the frozen spec tree, the
    // PHP plugin, and config noise. ESLint owns only the TS workspace packages.
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/node_modules/**',
      'plugins/**',
      '.wp-env-plugins/**',
      'plugin/**',
      'spec/**',
      '.claude/**',
      '*.config.mjs',
      'eslint.config.mjs',
      // WP-F03 runtime schema mirror lives outside the package tsconfig `src` rootDir
      // (`packages/shared/schemas/*`), so the type-checked `packages/**/*.ts` block cannot
      // resolve it under `parserOptions.project`. It is JSON data + a thin Ajv loader, linted
      // per-package via the `eslint src` script, not by the root type-aware pass.
      'packages/*/schemas/**',
    ],
  },
  {
    // Type-checked rules apply only to the TS source we own.
    files: ['packages/**/*.ts'],
    extends: [eslint.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        // Point type-checking at both workspace packages.
        project: ['./packages/server/tsconfig.json', './packages/shared/tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Ban `any` — use `unknown` + zod narrowing (Engineering Standards §2.1).
      '@typescript-eslint/no-explicit-any': 'error',
      // Every eslint-disable / ts-expect-error MUST carry a justification (§2.1, §2.3).
      'no-inline-comments': 'off',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-expect-error': 'allow-with-description',
          'ts-ignore': 'allow-with-description',
          'ts-nocheck': 'allow-with-description',
          minimumDescriptionLength: 10,
        },
      ],
    },
  },
  {
    // Require descriptions on eslint-disable directives.
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
  },
  {
    // Test files: vitest globals, slightly relaxed.
    files: ['**/*.test.ts', '**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },
);
