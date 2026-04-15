// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  // Ignore generated/build/vendor output across the workspace.
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.pnpm/**",
      "dashboard/dist/**",
      "**/*.config.js",
      "**/*.config.ts",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      // Type-strictness: allow `any` only where unavoidable (graphile-worker
      // and SDK internals lean on it). Warn so it surfaces in CI without
      // blocking builds.
      "@typescript-eslint/no-explicit-any": "warn",

      // Allow unused args/vars prefixed with `_`. Common pattern for express
      // middleware (`(_req, res, next)`) and "we know it's unused but the
      // signature requires it" cases.
      "@typescript-eslint/no-unused-vars": ["warn", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
      }],

      // Lots of dynamic JSON / DB row shapes; require-await is too strict.
      "@typescript-eslint/require-await": "off",

      // Off because we use string template-literal SQL with type-checked params.
      "@typescript-eslint/restrict-template-expressions": "off",
    },
  },

  // Tests: relax a few rules — describe.it patterns trip default no-misused-promises.
  {
    files: ["**/__tests__/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
);
