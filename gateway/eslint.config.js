import tseslint from 'typescript-eslint';

// Regeln, die genau die bekannten Fundtypen dauerhaft sperren.
// Browser-JS unter web/ laeuft nicht durch diesen Lint (kein TS, eigene Laufzeit).
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'web/**', 'coverage/**'] },
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: { projectService: false },
    },
    rules: {
      // Leere Bloecke nur mit Begruendung (Kommentar im Block).
      'no-empty': ['error', { allowEmptyCatch: false }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Env-Zahlen immer ueber envPositiveNumber() lesen (sonst NaN).
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.name='Number'] MemberExpression[object.name='process'][property.name='env']",
          message: 'Env-Zahlen nur ueber envPositiveNumber() lesen (sonst NaN).',
        },
      ],
    },
  }
);
