// Phase 0 (throwaway): record a scenario into a take folder.
// Usage: node scripts/record.ts --project p.yaml --scenario s.yaml --out <take dir> [--headed] [--dpr 2]
import { readFileSync } from "node:fs"
import { parseArgs } from "node:util"
import { recordScenario } from "@kiframe/runtime"
import { parseProjectYaml, parseScenarioYaml } from "@kiframe/schema"
import { chromium } from "playwright"

const { values } = parseArgs({
  options: {
    project: { type: "string" },
    scenario: { type: "string" },
    out: { type: "string" },
    headed: { type: "boolean", default: false },
    dpr: { type: "string", default: "2" },
  },
})
if (!values.project || !values.scenario || !values.out) {
  console.error("usage: --project <yaml> --scenario <yaml> --out <take dir> [--headed]")
  process.exit(2)
}
const project = parseProjectYaml(readFileSync(values.project, "utf8"))
const scenario = parseScenarioYaml(readFileSync(values.scenario, "utf8"))
const browser = await chromium.launch({ headless: !values.headed })
try {
  // Headed on a high-DPI screen: frames at device resolution (Phase 0 finding F2).
  const page = await browser.newPage({
    viewport: project.target.viewport,
    deviceScaleFactor: Number(values.dpr),
  })
  const take = await recordScenario(page, scenario, project, { outDir: values.out })
  console.log(
    `take ${take.meta.takeKey}: ${Math.round(take.meta.durationMs)} ms, ${take.warnings.length} warnings`,
  )
  for (const w of take.warnings) console.log(`warning: ${w}`)
} finally {
  await browser.close()
}
