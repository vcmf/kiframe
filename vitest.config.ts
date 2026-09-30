import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["{packages,apps}/*/{src,test}/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      // The shipped code (tests, fixtures and scripts aren't measured).
      include: ["{packages,apps}/*/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/*.d.ts"],
      reporter: ["text-summary", "lcov"],
      reportsDirectory: "coverage",
    },
  },
})
