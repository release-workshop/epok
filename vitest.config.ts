import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "packages/*/tests/**/*.test.ts",
      "examples/demo/tests/**/*.test.ts",
    ],
    exclude: ["packages/recorder/tests/bun-runtime-native.test.ts"],
  },
});
