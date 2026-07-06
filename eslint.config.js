const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const globals = require('globals');

module.exports = tseslint.config(
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        languageOptions: {
            globals: {
                ...globals.node,
            },
        },
        rules: {
            // Project uses `any` extensively for LLM/Telegraf integrations
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-require-imports': 'off',
            '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
            'no-console': 'off',
            // Empty catch blocks are used intentionally for migration idempotency
            'no-empty': ['error', { allowEmptyCatch: true }],
            // Useful but too noisy for existing codebase
            'no-useless-escape': 'warn',
            'prefer-const': 'warn',
        },
    },
    {
        ignores: ['dist/', 'node_modules/', 'coverage/', '*.config.js', '*.config.ts'],
    }
);
