import { builtinModules } from 'node:module';

import eslint from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// The limiter runs on any JavaScript runtime: no Node built-in, no timer, and no clock of its own
const FORBIDDEN_GLOBALS = [
    'Buffer',
    'Date',
    '__dirname',
    '__filename',
    'console',
    'global',
    'process',
    'require',
    'setImmediate',
    'setInterval',
    'setTimeout',
];

export default tseslint.config(
    eslint.configs.recommended,
    ...tseslint.configs.strict,
    eslintConfigPrettier,
    {
        rules: {
            '@typescript-eslint/no-explicit-any': 'warn',
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
            '@typescript-eslint/no-non-null-assertion': 'off',
        },
    },
    {
        files: ['src/**/*.ts'],
        rules: {
            'no-restricted-imports': ['error', { paths: builtinModules, patterns: ['node:*'] }],
            'no-restricted-globals': ['error', ...FORBIDDEN_GLOBALS],
        },
    },
    {
        files: ['tests/**/*.mjs'],
        languageOptions: { globals: globals.node },
    },
    {
        ignores: ['dist/', 'node_modules/'],
    },
);
