// P0-8 (throwaway): checks the Cal.com login preset alone. Prints the outcome and URL path only.
import { readFileSync } from "node:fs"
import { runScenario, StepError } from "@kiframe/runtime"
import { firstApp, parseProjectYaml, parseScenarioYaml } from "@kiframe/schema"
import { chromium } from "playwright"
import { envSecretResolver, loadDotEnv } from "../lib/secrets.ts"

loadDotEnv()
const project = parseProjectYaml(readFileSync("examples/calcom/project.yaml", "utf8"))
const scenario = parseScenarioYaml(
  "version: 1\nsetup: [{ preset: login }]\nsteps: [{ id: wait, action: pause, ms: 500 }]\n",
)
const env = envSecretResolver(["calcom.username", "calcom.password"], firstApp(project).app.url)
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
try {
  await runScenario(page, scenario, project, {
    // Approvals are the host's (SECRETS-DESIGN §3); the .env resolver here ignores them.
    scope: "phase0",
    sceneId: "login-check",
    resolveSecret: env,
    timeoutMs: Number(process.env.KF_TIMEOUT ?? 15_000),
  })
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
