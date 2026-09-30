import { parseProjectYaml, parseScenarioYaml } from "@kiframe/schema"
import { chromium, type Browser } from "playwright"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { runScenario, StepError, type RunnerEvent } from "../src/index.ts"
import { startFixtureServer } from "./fixture-server.ts"

let server: Awaited<ReturnType<typeof startFixtureServer>>
let browser: Browser
beforeAll(async () => {
  server = await startFixtureServer()
  browser = await chromium.launch()
})
afterAll(async () => {
  await browser.close()
  await server.close()
})

describe("stopping a run (its signal)", () => {
  it("stops at the next step, and still runs the teardown", async () => {
    const page = await browser.newPage()
    const project = parseProjectYaml(`version: 1
target: { kind: web, url: "${server.url}", viewport: { width: 800, height: 600 } }
defaults: { pacing: { settleMs: 0, cursor: instant, typing: instant } }
`)
    const scenario = parseScenarioYaml(`version: 1
setup: [{ action: goto, url: / }]
steps:
  - { id: first, action: pause, ms: 10 }
  - { id: second, action: pause, ms: 10 }
teardown: [{ action: pause, ms: 1 }]
`)
    const controller = new AbortController()
    const events: RunnerEvent[] = []
    const error = await runScenario(page, scenario, project, {
      signal: controller.signal,
      onEvent: (e) => {
        events.push(e)
        if (e.kind === "step_end" && e.step.stepId === "first") controller.abort()
      },
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(StepError)
    expect((error as StepError).reason).toBe("stopped")
    const started = events.flatMap((e) => (e.kind === "step_start" ? [e.step] : []))
    expect(started.some((s) => s.stepId === "second")).toBe(false)
    expect(started.some((s) => s.phase === "teardown")).toBe(true)
    await page.close()
  })
})
