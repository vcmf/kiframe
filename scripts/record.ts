// Phase 0 (throwaway): record a scenario into a take folder.
// Usage: node scripts/record.ts --project p.yaml --scenario s.yaml --out <take dir> [--headed] [--dpr 2]
//          [--secrets calcom.username,calcom.password] [--approve-risky]
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { recordScenario } from "@kiframe/runtime"
import { parseProjectYaml, parseScenarioYaml } from "@kiframe/schema"
import { chromium } from "playwright"
import { envSecretResolver, loadDotEnv, sceneIdOf } from "./lib/secrets.ts"

const { values } = parseArgs({
  options: {
    project: { type: "string" },
    scenario: { type: "string" },
    out: { type: "string" },
    headed: { type: "boolean", default: false },
    dpr: { type: "string" },
    /** Secret names the scene may use (`a.b` is read from env `A_B`, e.g. from a git-ignored .env). */
    secrets: { type: "string", default: "" },
    /** Pre-approve risky steps (a sandbox account's teardown deletes). */
    "approve-risky": { type: "boolean", default: false },
    /** The project's assets folder, for `upload` steps (`<sha256>.<ext>` files). */
    assets: { type: "string" },
    /** Step timeout (ms): real SaaS pages can take seconds to hydrate (FAILURE-CATALOGUE #8). */
    timeout: { type: "string", default: "15000" },
  },
})
if (!values.project || !values.scenario || !values.out) {
  console.error(
    "usage: --project <yaml> --scenario <yaml> --out <take dir> [--headed] [--dpr 2] [--secrets a.b,c.d] [--approve-risky] [--assets dir] [--timeout 15000]",
  )
  process.exit(2)
}
loadDotEnv()
const resolveSecret = envSecretResolver(values.secrets.split(",").filter(Boolean))
const timeoutMs = Number(values.timeout)
if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
  console.error(`--timeout takes milliseconds, got ${values.timeout}`)
  process.exit(2)
}
const project = parseProjectYaml(readFileSync(values.project, "utf8"))
// A high DPR only helps headed (headless frames stay at CSS resolution, F1): the project's DPR
// headed, 1 headless, unless --dpr says otherwise.
const dpr = Number(values.dpr ?? (values.headed ? project.target.viewport.deviceScaleFactor : 1))
if (!Number.isFinite(dpr) || dpr <= 0 || dpr > 3) {
  console.error(`--dpr must be a number in (0, 3], got ${values.dpr}`)
  process.exit(2)
}
const scenario = parseScenarioYaml(readFileSync(values.scenario, "utf8"))
const browser = await chromium.launch({ headless: !values.headed })
try {
  // Headed on a high-DPI screen: frames at device resolution (Phase 0 finding F2).
  const page = await browser.newPage({
    viewport: project.target.viewport,
    deviceScaleFactor: dpr,
  })
  const take = await recordScenario(page, scenario, project, {
    // Approvals are the host's (SECRETS-DESIGN §3); the .env resolver here ignores them.
    scope: "phase0",
    sceneId: sceneIdOf(values.scenario),
    outDir: values.out,
    resolveSecret,
    ...(values.assets !== undefined && {
      resolveAsset: (file: string) => {
        const path = join(values.assets as string, file)
        if (!existsSync(path)) throw new Error(`asset ${file} isn't in ${values.assets}`)
        return path
      },
    }),
    ...(values["approve-risky"] && { approveRisky: () => true }),
    timeoutMs,
  })
  console.log(
    `take ${take.meta.takeKey}: ${Math.round(take.meta.durationMs)} ms, ${take.warnings.length} warnings`,
  )
  for (const w of take.warnings) console.log(`warning: ${w}`)
} finally {
  await browser.close()
}
