// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import headerPlugin from "@tony.ganchev/eslint-plugin-header";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  eslintConfigPrettier,
  {
    ignores: ["**/dist/", "**/__generated__/"],
  },
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
    },
  },
  {
    files: ["**/*.test.ts", "**/*.e2e.test.ts"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // Tooling files outside any tsconfig project: root config files, package-local config
    // files and the scripts run via `tsx`. They get the header rule but no type-aware lint.
    files: ["eslint.config.js", "**/*.config.ts", "**/scripts/**/*.{js,mjs,cjs,ts}"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // Plain JS root files have no @types/node in scope; Node globals would trip `no-undef`.
    files: ["eslint.config.js", "**/scripts/**/*.{js,mjs,cjs}"],
    rules: {
      "no-undef": "off",
    },
  },
  {
    plugins: {
      header: headerPlugin,
    },
    rules: {
      "header/header": [
        "error",
        "line",
        [" SPDX-License-Identifier: AGPL-3.0-only", " Copyright (C) 2026 Oleksii PELYKH"],
      ],
    },
  },
);
