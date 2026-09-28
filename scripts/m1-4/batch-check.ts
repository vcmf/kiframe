// M1-4 (throwaway): the Phase 0 open item "one login per batch". Records N read-only Cal.com scenes
// in one batch and reports how many times the session preset ran (expected: once).
// Usage: node scripts/m1-4/batch-check.ts --out <dir> [--scenes 3] [--headed]
import { join } from "node:path"
import { readFileSync } from "node:fs"
import { parseArgs } from "node:util"
import { recordBatch } from "@kiframe/runtime"
import { parseProjectYaml, parseScenarioYaml } from "@kiframe/schema"
import { chromium } from "playwright"
import { envSecretResolver, loadDotEnv } from "../lib/secrets.ts"

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    scenes: { type: "string", default: "3" },
    headed: { type: "boolean", default: false },
  },
})
const count = Number(values.scenes)
if (!values.out || !Number.isInteger(count) || count < 1) {
  console.error("usage: --out <dir> [--scenes 3] [--headed]")
  process.exit(2)
}
loadDotEnv()
const root = join(import.meta.dirname, "..", "..")
const project = parseProjectYaml(readFileSync(join(root, "examples/calcom/project.yaml"), "utf8"))
// Read-only: open the event types and the bookings, nothing is created.
const scenario = parseScenarioYaml(`version: 1
setup: [{ preset: login }, { action: goto, url: /event-types }]
steps:
  - { id: types, action: expect, that: { url: /event-types } }
  - { id: bookings, action: goto, url: /bookings/upcoming }
  - { id: seen, action: expect, that: { url: /bookings } }
`)
const browser = await chromium.launch({ headless: !values.headed })
let logins = 0
try {
  const results = await recordBatch(
    browser,
    Array.from({ length: count }, (_, i) => ({
      scenario,
      outDir: join(values.out!, `scene-${i + 1}`),
    })),
    project,
    {
      resolveSecret: envSecretResolver(["calcom.username", "calcom.password"]),
      timeoutMs: 15000,
      onEvent: (e) => {
        if (e.kind === "preset_done" && e.session) logins++
      },
      onScene: (i, r) =>
        console.log(`scene ${i + 1}: ${r.ok ? "ok" : `failed: ${String(r.error).split("\n")[0]}`}`),
    },
  )
  const ok = results.filter((r) => r.ok).length
  console.log(`${ok}/${count} scenes ok, ${logins} login(s)`)
} finally {
  await browser.close()
}
