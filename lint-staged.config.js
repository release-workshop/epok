/** @type {import("lint-staged").Configuration} */
export default {
  "*.{ts,mts,cts}": [
    "eslint --fix --no-warn-ignored",
    "prettier --write",
    "vitest related --run --passWithNoTests",
  ],
  "*.{json,md,yml,yaml}": "prettier --write",
};
