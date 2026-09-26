import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["{packages,apps}/*/{src,test}/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}"],
  },
})
