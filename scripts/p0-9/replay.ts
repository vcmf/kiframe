// P0-9 (throwaway): replay one scene N times on a persistent profile and check every take is clean.
// The profile (cookies, localStorage, IndexedDB) is carried from run to run, like a real account
// whose data persists: session presets run once, then are skipped; `ensure` + `teardown` must keep
// the app in a state the scene can film. `--dirty 2,4` skips the final teardown of those runs, so
// the next run's `ensure` has leftovers to clean.
// Usage: node scripts/p0-9/replay.ts --project p.yaml --scenario s.yaml --out <dir> [--runs 5]
//          [--dirty 2,4] [--headed]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { sceneIdOf } from "../lib/scenes.ts"
import { parseArgs } from "node:util"
import { recordScenario, type RunnerEvent } from "@kiframe/runtime"
import { parseProjectYaml, parseScenarioYaml, startAppOf } from "@kiframe/schema"
import { chromium, type BrowserContextOptions } from "playwright"

const { values } = parseArgs({
  options: {
    project: { type: "string" },
    scenario: { type: "string" },
    out: { type: "string" },
    runs: { type: "string", default: "5" },
    dirty: { type: "string", default: "" },
    headed: { type: "boolean", default: false },
  },
})
if (!values.project || !values.scenario || !values.out) {
  console.error(
    "usage: --project <yaml> --scenario <yaml> --out <dir> [--runs 5] [--dirty 2,4] [--headed]",
  )
  process.exit(2)
}
const project = parseProjectYaml(readFileSync(values.project, "utf8"))
const scenario = parseScenarioYaml(readFileSync(values.scenario, "utf8"))
/** The app the scene starts in: replayed at its size, as it's filmed. */
const start = startAppOf(scenario, project).app
const runs = Number(values.runs)
const dirty = new Set(values.dirty.split(",").filter(Boolean).map(Number))
if (!Number.isInteger(runs) || runs < 1 || [...dirty].some((d) => !Number.isInteger(d) || d < 1)) {
  console.error("--runs and --dirty take positive whole numbers")
  process.exit(2)
}
// A dirty run has no teardown at all: after another dirty run, its `ensure` couldn't clean up.
for (const d of dirty) {
  if (dirty.has(d + 1)) {
    console.error(`--dirty runs can't be consecutive (${d}, ${d + 1})`)
    process.exit(2)
  }
}
mkdirSync(values.out, { recursive: true })

const browser = await chromium.launch({ headless: !values.headed })
let storageState: BrowserContextOptions["storageState"]
const sessions = new Set<string>()
const report: Record<string, unknown>[] = []
try {
  for (let run = 1; run <= runs; run++) {
    const context = await browser.newContext({
      viewport: {
        width: start.viewport.width,
        height: start.viewport.height,
      },
      deviceScaleFactor: values.headed ? start.viewport.deviceScaleFactor : 1,
      ...(storageState !== undefined && { storageState }),
    })
    const page = await context.newPage()
    const events: RunnerEvent[] = []
    const started = Date.now()
    const scene = dirty.has(run) ? { ...scenario, teardown: [] } : scenario
    const row: Record<string, unknown> = {
      run,
      dirty: dirty.has(run),
      skippedSessions: [...sessions],
    }
    try {
      const take = await recordScenario(page, scene, project, {
        scope: "phase0",
        sceneId: sceneIdOf(values.scenario),
        outDir: join(values.out, `run-${run}`),
        skipSessionPresets: [...sessions],
        // A sandbox app: the scene's risky teardown (delete) is pre-approved (APPROACHES §7.2).
        approveRisky: () => true,
        onEvent: (e) => events.push(e),
      })
      const cleanedUp = events.filter(
        (e) => e.kind === "step_start" && e.step.action.startsWith("ensure: "),
      ).length
      const ended = new Set(
        events.flatMap((e) =>
          e.kind === "step_end" && e.step.phase === "steps" ? [e.step.stepId] : [],
        ),
      )
      Object.assign(row, {
        clean:
          take.meta.outcome.status === "complete" &&
          take.warnings.length === 0 &&
          take.teardownError === undefined &&
          scenario.steps.every((s) => ended.has(s.id)),
        outcome: take.meta.outcome.status,
        warnings: take.warnings,
        teardownError: take.teardownError?.message,
        ensureRanTeardown: cleanedUp > 0,
        durationMs: Math.round(take.meta.durationMs),
      })
    } catch (error) {
      Object.assign(row, { clean: false, error: String(error).split("\n")[0] })
    }
    // Even from a failed run: its profile is carried over, with the session in it.
    for (const e of events) if (e.kind === "preset_done" && e.session) sessions.add(e.name)
    row.wallMs = Date.now() - started
    try {
      // Carried to the next run: the "account" keeps its data (IndexedDB included).
      storageState = await context.storageState({ indexedDB: true })
    } finally {
      await context.close()
    }
    report.push(row)
    console.log(JSON.stringify(row))
  }
} finally {
  await browser.close()
}
const clean = report.filter((r) => r.clean === true).length
console.log(`${clean}/${runs} clean takes`)
writeFileSync(join(values.out, "report.json"), JSON.stringify(report, null, 2) + "\n")
