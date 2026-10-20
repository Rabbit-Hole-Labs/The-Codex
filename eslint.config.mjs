import js from "@eslint/js";
import globals from "globals";
import { defineConfig } from "eslint/config";

export default defineConfig([
  // Global ignores. `.claude/**` keeps ESLint out of nested git worktrees
  // (.claude/worktrees/*), which otherwise get linted as part of this tree.
  {
    ignores: [
      ".claude/**",
      ".ds-sync/**",
      "coverage/**",
      "design-kit/dist/**",
      "node_modules/**"
    ]
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    plugins: { js },
    extends: ["js/recommended"],
    rules: {
      "no-unused-vars": ["warn", { "args": "none" }],
      "no-undef": ["error", { "typeof": true }],
      "no-console": "off"  // Allow console statements in Chrome extensions
    }
  },
  // Extension pages (new tab, manage, popup)
  {
    files: ["javascript/**/*.js"],
    ignores: ["javascript/background/**"],
    languageOptions: {
      globals: {
        ...globals.browser,
        chrome: "readonly",  // Chrome extension APIs
        CodexConsole: "writable"  // Global CodexConsole object
      }
    }
  },
  // MV3 service worker
  {
    files: ["javascript/background/**/*.js"],
    languageOptions: {
      globals: {
        ...globals.serviceworker,
        chrome: "readonly"
      }
    }
  },
  // Jest suites (jsdom) and Playwright helpers
  {
    files: ["tests/**/*.js"],
    languageOptions: {
      globals: {
        ...globals.jest,
        ...globals.browser,
        ...globals.node,
        chrome: "readonly",
        CodexConsole: "writable"
      }
    }
  },
  // Node tooling
  {
    files: ["*.{js,mjs,cjs}", "design-kit/*.mjs"],
    languageOptions: {
      globals: globals.node
    }
  }
]);
