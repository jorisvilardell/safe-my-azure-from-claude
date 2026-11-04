// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

/**
 * Architecture boundaries (see AGENTS.md §2):
 * - core/*      must not import features/* or app/*
 * - features/*  must not import app/* or another feature
 */
const noAppImport = {
  group: ['**/app/*', '**/app/**'],
  message: 'Features/core must not import app/ (composition root only).',
};

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**', '.claude/worktrees/**'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
    },
  },
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['**/features/*', '**/features/**'], message: 'core/ must stay feature-agnostic.' },
            noAppImport,
          ],
        },
      ],
    },
  },
  {
    files: ['src/features/*/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            noAppImport,
            {
              regex: '^\\.\\./(?!\\.\\.)',
              message: 'A feature must not import another feature. Move shared code to core/.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/features/*/__tests__/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            noAppImport,
            {
              regex: '^\\.\\./\\.\\./(?!\\.\\.)',
              message: 'A feature test must not import another feature.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
