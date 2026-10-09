import { configDefaults, defineConfig } from "vitest/config"

// The desktop-app target's tests launch a real Electron app each: they run alone, after every other
// suite (a CPU busy with them made timing-sensitive tests elsewhere flaky in CI).
const ELECTRON = "packages/runtime/test/electron.test.ts"

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      // The shipped code (tests, fixtures and scripts aren't measured).
      include: ["{packages,apps}/*/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/*.d.ts"],
      reporter: ["text-summary", "lcov"],
      reportsDirectory: "coverage",
    },
    projects: [
      {
        extends: true,
        test: {
          name: "kiframe",
          include: ["{packages,apps}/*/{src,test}/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}"],
          exclude: [...configDefaults.exclude, ELECTRON],
        },
      },
      {
        extends: true,
        test: { name: "electron", include: [ELECTRON], sequence: { groupOrder: 1 } },
      },
    ],
  },
})
