import js from "@eslint/js";
import tseslint from "typescript-eslint";
export default [
  ...tseslint.configs.recommended,
  { files: ["**/*.ts"], rules: js.configs.recommended.rules },
  { files: ["**/*.ts"], rules: { "no-undef": "off", "no-unused-vars": "off" } },
];
