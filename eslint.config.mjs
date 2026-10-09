import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

// React Hooks v7 ships React Compiler rules as errors. Keep rules-of-hooks as an
// error; everything else from that plugin is advisory so the hook never blocks
// on a pre-existing pattern.
const hooksRules = Object.fromEntries(
  Object.entries(reactHooks.configs.recommended.rules).map(([rule]) => [
    rule,
    rule === 'react-hooks/rules-of-hooks' ? 'error' : 'warn',
  ]),
);

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      '**/coverage/**',
      '**/next-env.d.ts',
      'supabase/**',
      'apps/ops/public/**',
      'adapters/nutrient/verification/samples/**',
      // Compiled .js siblings emitted beside every .ts (see .gitignore)
      'core/**/*.js',
      'adapters/**/*.js',
      'config/**/*.js',
      'test/**/*.js',
      'products/**/*.js',
      'services/**/*.js',
      'apps/**/src/**/*.js',
      'packages/**/*.js',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,mjs,js}'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    // Next.js apps: browser + Node globals. The Next lint rules
    // (@next/eslint-plugin-next) are withdrawn until braces ships a fix for
    // GHSA-vfj7-8cjw-p6xm, which fails the npm audit gate; see SR register.
    files: ['apps/**/*.{ts,tsx,mjs}', 'packages/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  {
    // React Hooks rules only where React components and hooks live. Server-side
    // code under apps/**/src/server has functions named use* that are not hooks.
    files: ['apps/**/*.tsx', 'apps/**/src/hooks/**/*.ts', 'packages/**/*.tsx'],
    ignores: ['apps/**/src/server/**'],
    plugins: { 'react-hooks': reactHooks },
    rules: hooksRules,
  },
  {
    // Server-side and library code
    files: [
      'core/**/*.ts',
      'services/**/*.ts',
      'adapters/**/*.ts',
      'products/**/*.ts',
      'config/**/*.ts',
      'test/**/*.{ts,tsx}',
      'scripts/**/*.mjs',
      '*.ts',
      '*.mjs',
    ],
    languageOptions: { globals: globals.node },
  },
);
