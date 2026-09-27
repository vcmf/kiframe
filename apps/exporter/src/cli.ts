// kiframe-export: take + scenario + project → MP4 (or WebM), through Electron's Chromium.
// Usage: node apps/exporter/src/cli.ts --project project.yaml --scenario scenario.yaml \
//          --take <take dir> --out demo.mp4 [--format mp4|webm] [--composition c.json]
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { bundleExportPage } from "@kiframe/compositor/browser/bundle.ts"
import { generate } from "@kiframe/generators"
import { Composition, parseProjectYaml, parseScenarioYaml } from "@kiframe/schema"
import { build } from "esbuild"
import { readTake } from "./take.ts"
import type { ExportJob } from "./main.ts"

const { values } = parseArgs({
  options: {
    project: { type: "string" },
    scenario: { type: "string" },
    take: { type: "string" },
    out: { type: "string" },
    format: { type: "string", default: "mp4" },
    composition: { type: "string" },
  },
})
if (!values.project || !values.scenario || !values.take || !values.out) {
  console.error(
    "usage: --project <yaml> --scenario <yaml> --take <dir> --out <file> [--format mp4|webm]",
  )
  process.exit(2)
}
const format = values.format === "webm" ? "webm" : "mp4"
const project = parseProjectYaml(readFileSync(values.project, "utf8"))
const scenario = parseScenarioYaml(readFileSync(values.scenario, "utf8"))
const takeDir = resolve(values.take)
const take = readTake(takeDir)
const generated = generate(project, scenario, take)
for (const w of generated.warnings) console.error(`warning: ${w}`)
const composition =
  values.composition === undefined
    ? generated.composition
    : Composition.parse(JSON.parse(readFileSync(values.composition, "utf8")))

// Bundle the Electron main and the export page into a temporary folder.
const work = mkdtempSync(join(tmpdir(), "kiframe-exporter-"))
writeFileSync(join(work, "export.js"), await bundleExportPage())
writeFileSync(
  join(work, "export.html"),
  '<!doctype html><meta charset="utf-8"><script type="module" src="export.js"></script>',
)
await build({
  entryPoints: [fileURLToPath(new URL("./main.ts", import.meta.url))],
  outfile: join(work, "main.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
  logLevel: "silent",
})

const job: ExportJob = {
  pageDir: work,
  takeDir,
  out: resolve(values.out),
  args: { composition, scenario, take, format },
}
const electron = createRequire(import.meta.url)("electron") as unknown as string
const run = spawnSync(electron, [join(work, "main.cjs")], {
  env: { ...process.env, KIFRAME_EXPORT: JSON.stringify(job) },
  stdio: ["ignore", "inherit", "inherit"],
  maxBuffer: 1 << 30,
})
process.exit(run.status ?? 1)
