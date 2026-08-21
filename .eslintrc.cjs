/** @type {import("eslint").Linter.Config} */
module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended-type-checked",
    "prettier"
  ],
  parserOptions: {
    project: true,
    tsconfigRootDir: __dirname
  },
  rules: {
    "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    "@typescript-eslint/no-explicit-any": "warn",
    "@typescript-eslint/explicit-function-return-type": "off",
    "@typescript-eslint/consistent-type-imports": "error"
  },
  ignorePatterns: ["dist/", "node_modules/", "*.js", "*.cjs", ".claude/"]
};
