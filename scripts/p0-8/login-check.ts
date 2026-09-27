// P0-8 (throwaway): checks the Cal.com login preset alone. Prints the outcome and URL path only.
import { readFileSync } from "node:fs"
import { runScenario, StepError } from "@kiframe/runtime"
import { parseProjectYaml, parseScenarioYaml } from "@kiframe/schema"
import { chromium } from "playwright"

process.loadEnvFile(".env")
const project = parseProjectYaml(readFileSync("examples/calcom/project.yaml", "utf8"))
const scenario = parseScenarioYaml(
  "version: 1\nsetup: [{ preset: login }]\nsteps: [{ id: wait, action: pause, ms: 500 }]\n",
)
const env = (name: string) => process.env[name.toUpperCase().replace(/[^A-Z0-9]/g, "_")] ?? ""
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
try {
  await runScenario(page, scenario, project, { resolveSecret: env, timeoutMs: 15_000 })
  console.log("login ok:", new URL(page.url()).pathname)
  if (process.argv[2] === "--list") {
    await page.waitForTimeout(2500)
    const snap = await page.locator("main").first().ariaSnapshot()
    console.log("intro call present:", /15 min intro call/i.test(snap))
  }
} catch (error) {
  console.log(
    "login failed:",
    error instanceof StepError ? error.message : String(error).split("\n")[0],
  )
  console.log("at:", new URL(page.url()).pathname)
} finally {
  await browser.close()
}
