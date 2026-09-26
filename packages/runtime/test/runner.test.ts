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
      .filter(
        (e): e is Extract<RunnerEvent, { kind: "step_start" | "step_end" }> =>
          e.kind === "step_start",
      )
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

  it("rejects presets it doesn't know and `ensure` (P0-9) with a StepError", async () => {
    const unknown = await failure(
      `setup: [{ preset: missing }]\nsteps: [{ id: a, action: pause, ms: 1 }]\n`,
    )
    expect(unknown.reason).toBe("invalid-setup")
    expect(unknown.message).toMatch(/unknown preset "missing"/)
    const ensure = await failure(
      `setup: [{ ensure: { absent: { by: text, text: X } } }]\nsteps: [{ id: a, action: pause, ms: 1 }]\n`,
    )
    expect(ensure.message).toMatch(/P0-9/)
  })

  // ─── Review round 1 (P0-3) ─────────────────────────────────────────────────

  it("ignores hidden duplicates of a target (responsive menus)", async () => {
    await run(`setup: [{ preset: open-projects }]
steps:
  - { id: settings, action: expect, that: { visible: { by: text, text: Settings } } }
  - { id: go, action: click, target: { by: text, text: Settings } }
`)
  })

  it("waits for visible text even when a hidden copy comes first", async () => {
    await page.goto(`${server.url}/projects`)
    await page.evaluate(() => {
      setTimeout(() => document.body.insertAdjacentHTML("beforeend", "<p>Saved!</p>"), 200)
    })
    await runScenario(
      page,
      scenario(`steps:\n  - { id: saved, action: waitFor, until: { text: "Saved!" } }\n`),
      project,
      {
        timeoutMs: 2000,
      },
    )
  })

  it("waits for requests started by the previous step (network idle)", async () => {
    await run(
      `setup: [{ preset: open-projects }]
steps:
  - { id: save, action: click, target: { by: role, role: button, name: Save remotely } }
  - { id: idle, action: waitFor, until: { networkIdle: true } }
  - { id: saved, action: expect, that: { text: Saved remotely }, timeout: 50 }
`,
      { timeoutMs: 4000 },
    )
  })

  it("matches URL conditions at path-segment boundaries", async () => {
    const expectUrl = (url: string) =>
      failure(
        `steps:\n  - { id: go, action: goto, url: /projects/12 }\n  - { id: at, action: expect, that: { url: ${url} }, timeout: 200 }\n`,
      )
    expect((await expectUrl("/projects/1")).reason).toBe("expectation-failed")
    await run(
      `steps:\n  - { id: go, action: goto, url: /projects/12 }\n  - { id: at, action: expect, that: { url: /projects } }\n`,
    )
  })

  it("scrolls the page, not the container under the mouse", async () => {
    await run(`setup: [{ preset: open-projects }]
steps:
  - { id: side, action: click, target: { by: role, role: button, name: Sidebar item } }
  - { id: down, action: scroll, by: { y: 500 } }
`)
    expect(await page.evaluate<number>("window.scrollY")).toBeGreaterThan(0)
    expect(await page.evaluate<number>("document.getElementById('sidebar').scrollTop")).toBe(0)
  })

  it("never waits forever on timeout: 0", async () => {
    const error = await failure(`setup: [{ preset: open-projects }]
steps:
  - { id: never, action: waitFor, until: { text: "Never shown" }, timeout: 0 }
`)
    expect(error.reason).toBe("condition-timeout")
  })

  it("runs teardown even when a step fails", async () => {
    const events: RunnerEvent[] = []
    await expect(
      runScenario(
        page,
        scenario(`setup: [{ preset: open-projects }]
steps:
  - { id: boom, action: click, target: { by: role, role: button, name: Missing } }
teardown:
  - { id: cleanup, action: goto, url: / }
`),
        project,
        { timeoutMs: 500, onEvent: (e) => events.push(e) },
      ),
    ).rejects.toThrow(/boom/)
    expect(events.some((e) => e.kind === "step_end" && e.step.stepId === "cleanup")).toBe(true)
  })

  // ─── Review round 2 (P0-3) ─────────────────────────────────────────────────

  it("types long text without hitting the step timeout", async () => {
    const long = "A".repeat(200)
    await run(`setup: [{ preset: open-projects }, { action: click, target: { by: role, role: button, name: New project } }]
steps:
  - { id: name, action: type, target: { by: label, name: Project name }, value: "${long}" }
`)
    expect(await page.getByLabel("Project name").inputValue()).toBe(long)
  })

  it("still picks the primary locator when it renders late, with fallbacks around", async () => {
    await page.goto(`${server.url}/projects`)
    await page.evaluate(() => {
      setTimeout(
        () => document.body.insertAdjacentHTML("beforeend", "<button>Late button</button>"),
        1200,
      )
    })
    await runScenario(
      page,
      scenario(`steps:
  - id: late
    action: click
    target:
      by: role
      role: button
      name: Late button
      fallbacks: [{ by: text, text: Nope 1 }, { by: text, text: Nope 2 }, { by: text, text: Nope 3 }, { by: text, text: Nope 4 }]
`),
      project,
      { timeoutMs: 5000 },
    )
  })

  it("sees a request the previous step just started, even after a quiet period", async () => {
    await run(
      `setup: [{ preset: open-projects }, { action: pause, ms: 800 }]
steps:
  - { id: save, action: click, target: { by: role, role: button, name: Save remotely } }
  - { id: idle, action: waitFor, until: { networkIdle: true } }
  - { id: saved, action: expect, that: { text: Saved remotely }, timeout: 50 }
`,
      { timeoutMs: 4000 },
    )
  })

  it("reaches network idle with an open SSE stream", async () => {
    await run(
      `steps:
  - { id: go, action: goto, url: /live }
  - { id: save, action: click, target: { by: role, role: button, name: Save } }
  - { id: idle, action: waitFor, until: { networkIdle: true } }
  - { id: saved, action: expect, that: { text: Saved }, timeout: 50 }
`,
      { timeoutMs: 4000 },
    )
  })

  it("treats `/` as the root only, and matches hash routes", async () => {
    const rootFails = await failure(
      `steps:\n  - { id: go, action: goto, url: /projects/12 }\n  - { id: home, action: expect, that: { url: / }, timeout: 200 }\n`,
    )
    expect(rootFails.reason).toBe("expectation-failed")
    await run(
      `steps:\n  - { id: go, action: goto, url: /projects#/settings/team }\n  - { id: at, action: expect, that: { url: "/projects#/settings" } }\n`,
    )
    const hashFails = await failure(
      `steps:\n  - { id: go, action: goto, url: /projects#/billing }\n  - { id: at, action: expect, that: { url: "/projects#/settings" }, timeout: 200 }\n`,
    )
    expect(hashFails.reason).toBe("expectation-failed")
  })

  // ─── Review round 3 (P0-3) ─────────────────────────────────────────────────

  it("follows a page that redirects itself on load", async () => {
    const events = await run(
      `steps:\n  - { id: go, action: goto, url: /redirect }\n  - { id: at, action: expect, that: { url: /projects } }\n`,
    )
    const urls = events.flatMap((e) => (e.kind === "navigate" ? [e.url] : []))
    expect(urls).toEqual([`${server.url}/redirect`, `${server.url}/projects`])
  })

  it("keeps waiting for a slow API call (5 s) before network idle", async () => {
    await run(
      `steps:
  - { id: go, action: goto, url: /report }
  - { id: gen, action: click, target: { by: role, role: button, name: Generate report } }
  - { id: idle, action: waitFor, until: { networkIdle: true } }
  - { id: ready, action: expect, that: { text: Report ready }, timeout: 50 }
`,
      { timeoutMs: 8000 },
    )
  }, 20_000)

  it("settles after an action: the next step sees the updated page without an explicit wait", async () => {
    await run(`steps:
  - { id: go, action: goto, url: /report }
  - { id: refresh, action: click, target: { by: role, role: button, name: Refresh } }
  - { id: updated, action: expect, that: { text: Updated }, timeout: 50 }
`)
  })

  it("scrolls the main pane of an app-shell layout", async () => {
    await run(`steps:
  - { id: go, action: goto, url: /shell }
  - { id: menu, action: click, target: { by: role, role: button, name: Menu } }
  - { id: down, action: scroll, by: { y: 800 } }
`)
    expect(await page.evaluate<number>("document.querySelector('main').scrollTop")).toBeGreaterThan(
      0,
    )
    expect(await page.evaluate<number>("document.querySelector('aside').scrollTop")).toBe(0)
    await run(
      `steps:
  - { id: go, action: goto, url: /shell }
  - { id: bottom, action: scroll, until: { by: text, text: Bottom of main } }
  - { id: top, action: scroll, until: { by: text, text: Top of main } }
`,
      { timeoutMs: 5000 },
    )
  })

  it("applies nth to the primary locator only", async () => {
    await run(`setup: [{ preset: open-projects }]
steps:
  - id: new
    action: click
    target: { by: role, role: button, name: Gone, nth: 1, fallbacks: [{ by: text, text: New project }] }
`)
  })

  it("adds text at the end of the field, on or off camera", async () => {
    const yaml = (
      instant: boolean,
    ) => `setup: [{ preset: open-projects }, { action: click, target: { by: role, role: button, name: New project } }]
steps:
  - { id: a, action: type, target: { by: label, name: Project name }, value: Acme, instant: true }
  - { id: b, action: type, target: { by: label, name: Project name }, value: " Inc", instant: ${instant} }
`
    await run(yaml(true))
    expect(await page.getByLabel("Project name").inputValue()).toBe("Acme Inc")
    await page.close()
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await run(yaml(false))
    expect(await page.getByLabel("Project name").inputValue()).toBe("Acme Inc")
  })

  it("lets a short networkIdle timeout pass on an idle page", async () => {
    await run(
      `setup: [{ preset: open-projects }]\nsteps:\n  - { id: idle, action: waitFor, until: { networkIdle: true }, timeout: 300 }\n`,
    )
  })

  // ─── Review round 4 (P0-3) ─────────────────────────────────────────────────

  it("appends to pre-filled inputs and textareas without relying on the End key", async () => {
    await run(`steps:
  - { id: go, action: goto, url: /prefilled }
  - { id: company, action: type, target: { by: label, name: Company }, value: " Inc" }
  - { id: notes, action: type, target: { by: label, name: Notes }, value: " end", instant: true }
`)
    expect(await page.getByLabel("Company").inputValue()).toBe("Acme Inc")
    expect(await page.getByLabel("Notes").inputValue()).toBe("line1\nline2 end")
  })

  it("doesn't run teardown when setup is invalid (nothing ran, nothing to clean)", async () => {
    const events: RunnerEvent[] = []
    await expect(
      runScenario(
        page,
        scenario(`setup: [{ preset: typo }]
steps: [{ id: a, action: pause, ms: 1 }]
teardown:
  - { id: cleanup, action: goto, url: / }
`),
        project,
        { onEvent: (e) => events.push(e) },
      ),
    ).rejects.toThrow(/unknown preset "typo"/)
    expect(events).toEqual([])
  })

  it("keeps looking for a target across a client-side redirect", async () => {
    await run(
      `steps:
  - { id: go, action: goto, url: /late-redirect }
  - { id: sign-in, action: click, target: { by: role, role: button, name: Sign in } }
`,
      { timeoutMs: 4000 },
    )
  })

  it("names the step when the risky approval itself fails", async () => {
    const error = await failure(
      `setup: [{ preset: open-projects }]\nsteps:\n  - { id: del, action: click, target: { by: role, role: button, name: New project }, risky: true }\n`,
      {
        approveRisky: () => {
          throw new Error("approval dialog closed")
        },
      },
    )
    expect(error.message).toMatch(/^steps\[0\] \(del, click\): approval dialog closed/)
  })

  it("says when a target stays covered instead of looping until the timeout", async () => {
    const error = await failure(
      `steps:
  - { id: go, action: goto, url: /covered }
  - { id: find, action: scroll, until: { by: text, text: Under the banner } }
`,
      { timeoutMs: 4000 },
    )
    expect(error.message).toMatch(/stays off screen/)
  })
})
