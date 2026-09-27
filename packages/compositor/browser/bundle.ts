import { build } from "esbuild"
import { fileURLToPath } from "node:url"

/** Bundles the export page script (one ES module, browser target). */
export async function bundleExportPage(): Promise<string> {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("./export-page.ts", import.meta.url))],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "chrome120",
    write: false,
    logLevel: "silent",
  })
  const file = result.outputFiles[0]
  if (file === undefined) throw new Error("esbuild produced no output")
  return file.text
}
