import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
import obsidianmd from "eslint-plugin-obsidianmd";

export default tseslint.config(
  {
    ignores: ["dist/**", "test/**", "esbuild.config.mjs", "package.json", "package-lock.json", "versions.json"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  ...obsidianmd.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        createDiv: "readonly",
        createEl: "readonly",
        createFragment: "readonly",
      },
      parserOptions: { project: "./tsconfig.json" },
    },
    rules: {
      "obsidianmd/ui/sentence-case": ["warn", { brands: ["Lumen", "Obsidian"] }],
    },
  },
);
