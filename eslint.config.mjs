import js from "@eslint/js";
import globals from "globals";
import { defineConfig } from "eslint/config";

export default defineConfig([
  {
    files: ["**/*.{js,mjs,cjs}"],
    ignores: ["tests/**/*.test.js", "tests/**/*.spec.js"],
    plugins: { js },
    extends: ["js/recommended"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        chrome: "readonly",  // Chrome extension APIs
        CodexConsole: "writable"  // Global CodexConsole object
      }
    },
    rules: {
      "no-unused-vars": ["warn", { "args": "none" }],
      "no-undef": ["error", { "typeof": true }],
      "no-console": "off"  // Allow console statements in Chrome extensions
    }
  },
  {
    files: ["tests/**/*.test.js", "tests/**/*.spec.js"],
    plugins: { js },
    extends: ["js/recommended"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.jest,
        chrome: "readonly",  // Chrome extension APIs
        CodexConsole: "writable"  // Global CodexConsole object
      }
    },
    rules: {
      "no-unused-vars": ["warn", { "args": "none" }],
      "no-undef": ["error", { "typeof": true }],
      "no-console": "off"  // Allow console statements in Chrome extensions
    }
  }
]);
