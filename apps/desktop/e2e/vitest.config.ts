import { defineConfig } from "vitest/config"

// The end-to-end tests launch the built app (`pnpm e2e` builds it first); kept out of `pnpm test`.
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ["**/*.e2e.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
