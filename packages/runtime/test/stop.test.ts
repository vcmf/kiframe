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
  it("stops at the next step, and runs nothing more (not the teardown)", async () => {
    const page = await browser.newPage()
    const project = parseProjectYaml(`version: 2
apps: { app: { kind: web, url: "${server.url}", viewport: { width: 800, height: 600 } } }
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
    expect(started.some((s) => s.phase === "teardown")).toBe(false)
    await page.close()
  })

  it("runs no teardown after a stop during the setup (it would clean what this run didn't make)", async () => {
    const page = await browser.newPage()
    const project = parseProjectYaml(`version: 2
apps: { app: { kind: web, url: "${server.url}", viewport: { width: 800, height: 600 } } }
defaults: { pacing: { settleMs: 0, cursor: instant, typing: instant } }
`)
    const scenario = parseScenarioYaml(`version: 1
setup:
  - { action: goto, url: / }
  - { action: pause, ms: 1 }
steps: [{ id: a, action: pause, ms: 1 }]
teardown: [{ action: pause, ms: 1 }]
`)
    const controller = new AbortController()
    const events: RunnerEvent[] = []
    const error = await runScenario(page, scenario, project, {
      signal: controller.signal,
      onEvent: (e) => {
        events.push(e)
        if (e.kind === "step_end" && e.step.phase === "setup" && e.step.index === 0) {
          controller.abort()
        }
      },
    }).catch((e: unknown) => e)
    expect((error as StepError).reason).toBe("stopped")
    const started = events.flatMap((e) => (e.kind === "step_start" ? [e.step] : []))
    expect(started.some((s) => s.phase === "teardown")).toBe(false)
    await page.close()
  })

  it("stops before an ensure: its check, and the teardown it would run, never start", async () => {
    const page = await browser.newPage()
    const project = parseProjectYaml(`version: 2
apps: { app: { kind: web, url: "${server.url}", viewport: { width: 800, height: 600 } } }
defaults: { pacing: { settleMs: 0, cursor: instant, typing: instant } }
`)
    // The leftover is there: without the stop, the ensure would run the teardown to remove it.
    const scenario = parseScenarioYaml(`version: 1
setup:
  - { action: goto, url: / }
  - ensure: { absent: { by: text, text: Welcome } }
steps: [{ id: a, action: pause, ms: 1 }]
teardown: [{ action: pause, ms: 1 }]
`)
    const controller = new AbortController()
    const events: RunnerEvent[] = []
    const error = await runScenario(page, scenario, project, {
      signal: controller.signal,
      onEvent: (e) => {
        events.push(e)
        if (e.kind === "step_end" && e.step.phase === "setup" && e.step.index === 0) {
          controller.abort()
        }
      },
    }).catch((e: unknown) => e)
    expect((error as StepError).reason).toBe("stopped")
    expect((error as StepError).step.action).toBe("ensure")
    const started = events.flatMap((e) => (e.kind === "step_start" ? [e.step] : []))
    expect(started.some((s) => s.action.startsWith("ensure: "))).toBe(false)
    await page.close()
  })

  it("reports a stop that closed a dialog as a stop, and runs nothing more", async () => {
    const page = await browser.newPage()
    const project = parseProjectYaml(`version: 2
apps: { app: { kind: web, url: "${server.url}", viewport: { width: 800, height: 600 } } }
defaults: { pacing: { settleMs: 0, cursor: instant, typing: instant } }
`)
    const scenario = parseScenarioYaml(`version: 1
setup: [{ action: goto, url: / }]
steps:
  - { id: del, action: click, target: { by: role, role: link, name: Projects }, risky: true }
  - { id: after, action: pause, ms: 1 }
teardown: [{ action: pause, ms: 1 }]
`)
    const controller = new AbortController()
    const events: RunnerEvent[] = []
    const error = await runScenario(page, scenario, project, {
      signal: controller.signal,
      onEvent: (e) => events.push(e),
      // The user stops while the dialog is open: the host closes it, rejecting.
      approveRisky: () => {
        controller.abort()
        return Promise.reject(controller.signal.reason as Error)
      },
    }).catch((e: unknown) => e)
    expect((error as StepError).reason).toBe("stopped")
    const started = events.flatMap((e) => (e.kind === "step_start" ? [e.step] : []))
    expect(started.some((s) => s.phase === "teardown")).toBe(false)
    await page.close()
  })

  it("runs no teardown after a stop that lands once the steps are done", async () => {
    const page = await browser.newPage()
    const project = parseProjectYaml(`version: 2
apps: { app: { kind: web, url: "${server.url}", viewport: { width: 800, height: 600 } } }
defaults: { pacing: { settleMs: 0, cursor: instant, typing: instant } }
`)
    const scenario = parseScenarioYaml(`version: 1
setup: [{ action: goto, url: / }]
steps: [{ id: last, action: pause, ms: 1 }]
teardown: [{ action: pause, ms: 1 }]
`)
    const controller = new AbortController()
    const events: RunnerEvent[] = []
    const error = await runScenario(page, scenario, project, {
      signal: controller.signal,
      onEvent: (e) => {
        events.push(e)
        if (e.kind === "step_end" && e.step.stepId === "last") controller.abort()
      },
    }).catch((e: unknown) => e)
    expect((error as StepError).reason).toBe("stopped")
    const started = events.flatMap((e) => (e.kind === "step_start" ? [e.step] : []))
    expect(started.some((s) => s.phase === "teardown")).toBe(false)
    await page.close()
  })

  it("reports a stop during the teardown as a stop, even after a failure", async () => {
    const page = await browser.newPage()
    const project = parseProjectYaml(`version: 2
apps: { app: { kind: web, url: "${server.url}", viewport: { width: 800, height: 600 } } }
defaults: { pacing: { settleMs: 0, cursor: instant, typing: instant } }
`)
    const scenario = parseScenarioYaml(`version: 1
setup: [{ action: goto, url: / }]
steps:
  - { id: fails, action: expect, that: { url: /nowhere } }
teardown:
  - { action: pause, ms: 1 }
  - { action: pause, ms: 1 }
`)
    const controller = new AbortController()
    const events: RunnerEvent[] = []
    const error = await runScenario(page, scenario, project, {
      signal: controller.signal,
      timeoutMs: 300,
      onEvent: (e) => {
        events.push(e)
        if (e.kind === "step_end" && e.step.phase === "teardown") controller.abort()
      },
    }).catch((e: unknown) => e)
    expect((error as StepError).reason).toBe("stopped")
    const teardown = events.flatMap((e) =>
      e.kind === "step_start" && e.step.phase === "teardown" ? [e.step] : [],
    )
    expect(teardown).toHaveLength(1)
    await page.close()
  })
})
