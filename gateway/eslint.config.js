import tseslint from 'typescript-eslint';

// Regeln, die genau die bekannten Fundtypen dauerhaft sperren.
// Browser-JS unter web/ laeuft nicht durch diesen Lint (kein TS, eigene Laufzeit).
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'web/**', 'coverage/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      // Leere Bloecke nur mit Begruendung (Kommentar im Block).
      'no-empty': ['error', { allowEmptyCatch: false }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          // Env-Zahlen immer ueber envPositiveNumber() lesen (sonst NaN).
          selector:
            "CallExpression[callee.name='Number'] MemberExpression[object.name='process'][property.name='env']",
          message: 'Env-Zahlen nur ueber envPositiveNumber() lesen (sonst NaN).',
        },
        {
          // Test-Hooks gehoeren nicht in Produktionscode; Abhaengigkeit injizieren.
          selector: 'ExportNamedDeclaration > FunctionDeclaration[id.name=/ForTests$/]',
          message: 'Test-Hooks nicht aus Produktionscode exportieren; Abhaengigkeit injizieren.',
        },
      ],
    },
  },
  {
    // Bestehende Test-Hooks (Ratchet): hier ist die Export-Regel ausgenommen.
    // Beim Abbau eines Hooks den Dateieintrag loeschen. Die Env-Regel gilt
    // in diesen Dateien weiter.
    files: [
      'src/core/entityIndex.ts',
      'src/core/http.ts',
      'src/core/httpCache.ts',
      'src/core/session.ts',
      'src/rateLimit.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.name='Number'] MemberExpression[object.name='process'][property.name='env']",
          message: 'Env-Zahlen nur ueber envPositiveNumber() lesen (sonst NaN).',
        },
      ],
    },
  },
  {
    // Tests duerfen Test-Hooks nutzen und Env-Werte setzen.
    files: ['test/**/*.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  }
);
