import { resolve } from "node:path"
import react from "@vitejs/plugin-react"
import { defineConfig, externalizeDepsPlugin } from "electron-vite"

// The workspace packages are TypeScript sources: bundled into main (never loaded as is at
// runtime). Their own dependencies (zod, playwright, the keyring's native module) stay external.
const bundled = [
  "@kiframe/agent",
  "@kiframe/generators",
  "@kiframe/project",
  "@kiframe/runtime",
  "@kiframe/schema",
  "@kiframe/studio",
  "@kiframe/vault",
]

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: bundled })],
    build: {
      outDir: "out/main",
      lib: { entry: resolve(import.meta.dirname, "src/main/index.ts") },
    },
  },
  preload: {
    // Sandboxed: one CommonJS file, nothing but Electron's own modules at runtime.
    build: {
      outDir: "out/preload",
      lib: { entry: resolve(import.meta.dirname, "src/preload/index.ts") },
      rollupOptions: {
        external: ["electron"],
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, "src/renderer"),
    build: {
      outDir: resolve(import.meta.dirname, "out/renderer"),
      // Every asset a file (small fonts too): the CSP allows the app's own files, no data: URIs.
      assetsInlineLimit: 0,
      rollupOptions: { input: resolve(import.meta.dirname, "src/renderer/index.html") },
    },
    plugins: [react()],
  },
})
