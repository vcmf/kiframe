import { parseProjectYaml, parseScenarioYaml, type ProjectConfig } from "@kiframe/schema"
import { chromium, type Browser, type Page } from "playwright"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { runScenario, StepError, type RunnerEvent } from "../src/index.ts"
import { startFixtureServer } from "./fixture-server.ts"

let server: Awaited<ReturnType<typeof startFixtureServer>>
let browser: Browser
let page: Page
let project: ProjectConfig

beforeAll(async () => {
  server = await startFixtureServer()
  browser = await chromium.launch()
  project = parseProjectYaml(`version: 1
target: { kind: web, url: "${server.url}", viewport: { width: 1280, height: 800 } }
defaults: { pacing: { settleMs: 0 } }
presets:
  open-projects:
    steps: [{ action: goto, url: /projects }]
`)
})

afterAll(async () => {
  await browser.close()
  await server.close()
})

beforeEach(async () => {
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  return () => page.close()
})

const scenario = (yaml: string) => parseScenarioYaml(`version: 1\n${yaml}`)

async function run(yaml: string, options: Parameters<typeof runScenario>[3] = {}) {
  const events: RunnerEvent[] = []
  await runScenario(page, scenario(yaml), project, {
    timeoutMs: 1500,
    onEvent: (e) => events.push(e),
    ...options,
  })
  return events
}

async function failure(
  yaml: string,
  options: Parameters<typeof runScenario>[3] = {},
): Promise<StepError> {
  try {
    await run(yaml, options)
  } catch (error) {
    if (error instanceof StepError) return error
    throw error
  }
  throw new Error("expected the scenario to fail")
}

describe("runScenario", { timeout: 30_000 }, () => {
  it("runs the documented flow: preset setup, click, type, submit, waitFor", async () => {
    const events = await run(`setup:
  - preset: open-projects
steps:
  - { id: open-new, action: click, target: { by: role, role: button, name: New project } }
  - { id: name-project, action: type, target: { by: label, name: Project name }, value: Q4 Launch }
  - { id: create, action: click, target: { by: role, role: button, name: Create } }
  - { id: done, action: waitFor, until: { text: "Project created: Q4 Launch" } }
  - { id: url, action: expect, that: { url: /projects/1 } }
`)
    const starts = events
      .filter((e) => e.kind === "step_start")
      .map((e) => `${e.step.phase}:${e.step.stepId ?? e.step.index}`)
    expect(starts).toEqual([
      "setup:0",
      "steps:open-new",
      "steps:name-project",
      "steps:create",
      "steps:done",
      "steps:url",
    ])
    expect(events.find((e) => e.kind === "navigate")).toMatchObject({
      url: `${server.url}/projects`,
    })
  })

  it("falls back to the next locator when the primary one is gone", async () => {
    await run(`setup: [{ preset: open-projects }]
steps:
  - id: open
    action: click
    target: { by: role, role: button, name: Renamed button, fallbacks: [{ by: text, text: New project }] }
  - { id: see, action: expect, that: { visible: { by: label, name: Project name } } }
`)
  })

  it("names the step and what was tried when a target is missing", async () => {
    const error = await failure(`setup: [{ preset: open-projects }]
steps:
  - { id: nope, action: click, target: { by: role, role: button, name: Missing, fallbacks: [{ by: text, text: Also missing }] } }
`)
    expect(error.reason).toBe("target-not-found")
    expect(error.message).toMatch(
      /^steps\[0\] \(nope, click\): target not found — tried role button "Missing", then text "Also missing"/,
    )
  })

  it("refuses to guess between several matching elements", async () => {
    const error = await failure(`setup: [{ preset: open-projects }]
steps:
  - { id: save, action: click, target: { by: role, role: button, name: Save } }
`)
    expect(error.reason).toBe("target-ambiguous")
    await run(`setup: [{ preset: open-projects }]
steps:
  - { id: save, action: click, target: { by: role, role: button, name: Save, nth: 1 } }
`)
  })

  it("reports ungrounded targets instead of guessing", async () => {
    const error = await failure(`steps:
  - { id: a, action: click, target: { intent: "the New project button" } }
`)
    expect(error.reason).toBe("not-grounded")
  })

  it("types secrets from the resolver and never reports the value", async () => {
    const events = await run(
      `setup: [{ preset: open-projects }, { action: click, target: { by: role, role: button, name: New project } }]
steps:
  - { id: pw, action: type, target: { by: label, name: Password }, value: "{{secrets.acme.password}}" }
`,
      { resolveSecret: (name) => (name === "acme.password" ? "hunter2-secret" : "") },
    )
    expect(await page.getByLabel("Password").inputValue()).toBe("hunter2-secret")
    expect(JSON.stringify(events)).not.toContain("hunter2-secret")
    expect(events.find((e) => e.kind === "type")).toMatchObject({ secret: "acme.password" })
  })

  it("fails clearly when a secret is unavailable, without leaking the resolver's error", async () => {
    const error = await failure(
      `setup: [{ preset: open-projects }, { action: click, target: { by: role, role: button, name: New project } }]
steps:
  - { id: pw, action: type, target: { by: label, name: Password }, value: "{{secrets.acme.password}}" }
`,
      {
        resolveSecret: () => {
          throw new Error("vault said: value hunter2 expired")
        },
      },
    )
    expect(error.reason).toBe("secret-unavailable")
    expect(error.message).not.toContain("hunter2")
  })

  it("presses shortcuts with Mod = Cmd/Ctrl", async () => {
    await run(`setup: [{ preset: open-projects }]
steps:
  - { id: palette, action: press, keys: Mod+k }
  - { id: open, action: expect, that: { text: Palette open } }
`)
  })

  it("scrolls by an amount, to a target, and until a target appears", async () => {
    await run(
      `setup: [{ preset: open-projects }]\nsteps:\n  - { id: down, action: scroll, by: { y: 600 } }\n`,
    )
    expect(await page.evaluate<number>("window.scrollY")).toBeGreaterThan(0)

    await run(
      `setup: [{ preset: open-projects }]\nsteps:\n  - { id: footer, action: scroll, to: { by: text, text: Footer text } }\n`,
    )
    await expect(page.getByText("Footer text").isVisible()).resolves.toBe(true)
    expect(await page.evaluate<number>("window.scrollY")).toBeGreaterThan(2000)

    await run(
      `setup: [{ preset: open-projects }]
steps:
  - { id: deep, action: scroll, until: { by: text, text: Deep item }, within: { by: css, selector: "#list" } }
`,
      { timeoutMs: 8000 },
    )
    expect(
      await page.evaluate<number>("document.getElementById('list').scrollTop"),
    ).toBeGreaterThan(0)
  })

  it("runs risky steps only when approved", async () => {
    const risky = `setup: [{ preset: open-projects }]
steps:
  - { id: del, action: click, target: { by: role, role: button, name: New project }, risky: true }
`
    expect((await failure(risky)).reason).toBe("risky-not-approved")
    await run(risky, { approveRisky: () => true })
  })

  it("times out waitFor and expect with the step named", async () => {
    const error = await failure(`setup: [{ preset: open-projects }]
steps:
  - { id: never, action: waitFor, until: { text: "Never shown" }, timeout: 300 }
`)
    expect(error.reason).toBe("condition-timeout")
    expect(error.message).toMatch(/^steps\[0\] \(never, waitFor\): .*Never shown/)
  })

  it("rejects presets it doesn't know and `ensure` (P0-9) with a clear error", async () => {
    await expect(
      run(`setup: [{ preset: missing }]\nsteps: [{ id: a, action: pause, ms: 1 }]\n`),
    ).rejects.toThrow(/unknown preset "missing"/)
    await expect(
      run(
        `setup: [{ ensure: { absent: { by: text, text: X } } }]\nsteps: [{ id: a, action: pause, ms: 1 }]\n`,
      ),
    ).rejects.toThrow(/P0-9/)
  })
})
