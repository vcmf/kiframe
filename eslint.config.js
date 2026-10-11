import js from "@eslint/js"
import { defineConfig } from "eslint/config"
import tseslint from "typescript-eslint"

export default defineConfig(
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      ".kiframe-local/**",
      "apps/desktop/out/**",
      // A fixture desktop app (plain CommonJS Electron loads as is: never part of a TS project).
      "packages/runtime/test/fixtures/electron-app/**",
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  { files: ["**/*.js"], extends: [tseslint.configs.disableTypeChecked] },
)
