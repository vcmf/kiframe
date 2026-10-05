// kiframe-export: take + scenario + project → MP4 (or WebM), through Electron's Chromium.
// Usage: node apps/exporter/src/cli.ts --project project.yaml --scenario scenario.yaml \
//          --take <take dir> --out demo.mp4 [--format mp4|webm] [--composition c.json]
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, extname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { bundleExportPage } from "@kiframe/compositor/browser/bundle.ts"
import { buildTimeline, generate } from "@kiframe/generators"
import {
  applyStyle,
  DEFAULT_STYLE,
  parseCompositionJson,
  parseProjectYaml,
  parseScenarioYaml,
  type Composition,
} from "@kiframe/schema"
import { build } from "esbuild"
import { isEncryptedFile } from "@kiframe/project/take-crypt"
import { readTakeRecords } from "@kiframe/project/take-records"
import { backgroundFile } from "./background.ts"
import type { ExportJob } from "./main.ts"

const { values } = parseArgs({
  options: {
    project: { type: "string" },
    scenario: { type: "string" },
    take: { type: "string" },
    out: { type: "string" },
    format: { type: "string" },
    composition: { type: "string" },
  },
})
if (!values.project || !values.scenario || !values.take || !values.out) {
  console.error(
    "usage: --project <yaml> --scenario <yaml> --take <dir> --out <file> [--format mp4|webm]",
  )
  process.exit(2)
}
// The format follows the file name unless --format says so; a mismatch is an error.
const ext = extname(values.out).slice(1).toLowerCase()
const format = values.format ?? ext
if (format !== "mp4" && format !== "webm") {
  console.error(
    `unknown format ${JSON.stringify(format)}: mp4 or webm (--format, or the --out extension)`,
  )
  process.exit(2)
}
if (ext !== format) {
  console.error(`--out ${values.out} doesn't end in .${format}`)
  process.exit(2)
}
const project = parseProjectYaml(readFileSync(values.project, "utf8"))
const scenario = parseScenarioYaml(readFileSync(values.scenario, "utf8"))
const takeDir = resolve(values.take)
// An encrypted take (the app's take store) is exported from the app, which has its key.
if (await isEncryptedFile(join(takeDir, "frames.webm"))) {
  console.error("the take is encrypted (the app's take store): export it from the app")
  process.exit(2)
}
const take = readTakeRecords(takeDir)
// An edited composition is rendered as is; otherwise the generators make one from the take.
let composition: Composition
if (values.composition === undefined) {
  const generated = generate(project, scenario, take)
  for (const w of generated.warnings) console.error(`warning: ${w}`)
  composition = generated.composition
} else {
  composition = parseCompositionJson(readFileSync(values.composition, "utf8"))
  // Anchors are relative to steps: on another take they land at other times (a mask could start
  // late). Say so; the user may have re-recorded on purpose.
  if (composition.take !== undefined && composition.take.key !== take.meta.takeKey) {
    console.error(
      `warning: the composition was made for take ${composition.take.key}, this is ${take.meta.takeKey}: check the timing (masks especially)`,
    )
  }
  for (const id of buildTimeline(scenario, take).missing) {
    console.error(`warning: step ${id} isn't in the take: its segments are skipped`)
  }
}
// Fail now, not after the whole export: the output folder must exist.
const out = resolve(values.out)
if (!existsSync(dirname(out))) {
  console.error(`the output folder ${dirname(out)} doesn't exist`)
  process.exit(2)
}

// The scene's background image, checked now: the composition's style over the product defaults,
// as the export page lays it (a project file here has no style of its own).
let background: string | undefined
try {
  background = backgroundFile(applyStyle(DEFAULT_STYLE, composition.style).background)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(2)
}

// Bundle the Electron main and the export page into a temporary folder.
const work = mkdtempSync(join(tmpdir(), "kiframe-exporter-"))
let status: number
try {
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
    out,
    ...(background !== undefined && { backgroundFile: background }),
    args: { composition, scenario, take, format },
  }
  const jobFile = join(work, "job.json")
  writeFileSync(jobFile, JSON.stringify(job))
  const electron = createRequire(import.meta.url)("electron") as unknown as string
  const child = spawn(electron, [join(work, "main.cjs")], {
    env: { ...process.env, KIFRAME_EXPORT_JOB: jobFile },
    stdio: ["ignore", "inherit", "inherit"],
  })
  // Ctrl-C: stop Electron and still remove the folder (job.json holds the whole take).
  const stop = () => child.kill()
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  status = await new Promise<number>((resolveStatus) => {
    child.once("error", (error) => {
      console.error(`couldn't start Electron: ${error.message}`)
      resolveStatus(1)
    })
    child.once("exit", (code) => resolveStatus(code ?? 1))
  })
} finally {
  // job.json holds the whole take: never left behind.
  rmSync(work, { recursive: true, force: true })
}
process.exit(status)
