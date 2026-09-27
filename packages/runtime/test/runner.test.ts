import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseProjectYaml, parseScenarioYaml, type ProjectConfig } from "@kiframe/schema"
import { chromium, type Browser, type Page } from "playwright"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
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
defaults: { pacing: { settleMs: 0, cursor: instant, typing: instant } }
presets:
  open-projects:
    steps: [{ action: goto, url: /projects }]
  sign-in:
    session: true
    steps: [{ action: goto, url: /login }]
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

  it("rejects presets it doesn't know with a StepError", async () => {
    const unknown = await failure(
      `setup: [{ preset: missing }]\nsteps: [{ id: a, action: pause, ms: 1 }]\n`,
    )
    expect(unknown.reason).toBe("invalid-setup")
    expect(unknown.message).toMatch(/unknown preset "missing"/)
  })

  it("says why a click failed when the target is off screen (collapsed panel)", async () => {
    const error = await failure(
      `setup: [{ action: goto, url: /collapsed }]
steps: [{ id: open, action: click, target: { by: role, role: button, name: New board, exact: true } }]
`,
      // With no on-screen point to probe, the risky check fails closed: approved here, like the
      // grounding harness does, to reach the click itself.
      { approveRisky: () => true },
    )
    expect(error.reason).toBe("target-not-found")
    expect(error.message).toMatch(/off screen even after scrolling .*collapsed panel/)
  })

  it("still clicks a button scrolled out of an inner scroll container (app shell)", async () => {
    await run(`setup:
  - { action: goto, url: /shell-scroll }
  - { action: scroll, within: { by: css, selector: "#m" }, by: { y: 3000 } }
steps: [{ id: top, action: click, target: { by: role, role: button, name: Top action } }]
`)
    expect(await page.locator("#s").textContent()).toBe("Top clicked")
  })

  it("waits for a primary target that is sliding in, rather than jumping to a fallback", async () => {
    const events = await run(`setup: [{ action: goto, url: /drawer }]
steps:
  - { id: open, action: click, target: { by: role, role: button, name: Open drawer } }
  - id: del
    action: click
    risky: false
    target: { by: role, role: button, name: Delete, exact: true, fallbacks: [{ by: role, role: button, name: Delete elsewhere }] }
`)
    expect(await page.locator("#s").textContent()).toBe("drawer")
    expect(events.some((e) => e.kind === "target_fallback")).toBe(false)
  })

  it("still types into an input hidden off screen on purpose", async () => {
    await run(`setup: [{ action: goto, url: /collapsed }]
steps: [{ id: t, action: type, target: { by: label, name: Hidden field }, value: abc }]
`)
    expect(await page.locator("#v").textContent()).toBe("abc")
  })

  // ─── M1-2: select, drag, upload, tabs and popups ───────────────────────────

  it("selects a native option by label or by value", async () => {
    await run(`setup: [{ action: goto, url: /controls }]
steps: [{ id: pick, action: select, target: { by: label, name: Plan }, option: Pro plan }]
`)
    expect(await page.locator("#s").textContent()).toBe("plan pro")
    await run(`setup: [{ action: goto, url: /controls }]
steps: [{ id: pick, action: select, target: { by: label, name: Plan }, option: pro }, { id: back, action: select, target: { by: label, name: Plan }, option: free }]
`)
    expect(await page.locator("#s").textContent()).toBe("plan free")
  })

  it("drags by an offset on camera, with the button held along the path", async () => {
    const events = await run(
      `setup: [{ action: goto, url: /drag }]
steps: [{ id: slide, action: drag, target: { by: role, role: slider, name: Volume }, to: { dx: 200, dy: 0 } }]
`,
    )
    const left = Number((await page.locator("#s").textContent())?.replace("knob ", ""))
    expect(Math.abs(left - 300)).toBeLessThan(25)
    const pressed = events.flatMap((e) => (e.kind === "cursor" ? [e.pressed] : []))
    expect(pressed.filter(Boolean).length).toBeGreaterThan(1)
    expect(pressed.at(-1)).toBe(false)
  })

  it("drags onto another element (HTML5 drag and drop), on and off camera", async () => {
    for (const yaml of [
      `steps: [{ id: move, action: drag, target: { by: text, text: Card }, to: { by: text, text: Done } }]`,
      `setup: [{ action: goto, url: /drag }, { action: drag, target: { by: text, text: Card }, to: { by: text, text: Done } }]\nsteps: [{ id: a, action: pause, ms: 1 }]`,
    ]) {
      await page.goto(`${server.url}/drag`)
      const scene = yaml.startsWith("steps")
        ? `setup: [{ action: goto, url: /drag }]\n${yaml}\n`
        : `${yaml}\n`
      await run(scene)
      expect(await page.locator("#s").textContent()).toBe("dropped card")
    }
  })

  it("uploads a project asset into a file input, or through the chooser a button opens", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kiframe-asset-"))
    const asset = `${"a".repeat(64)}.txt`
    writeFileSync(join(dir, asset), "hello")
    const resolveAsset = (file: string) => join(dir, file)
    await run(
      `setup: [{ action: goto, url: /upload }]
steps: [{ id: attach, action: upload, target: { by: label, name: Attachment }, file: ${asset} }]
`,
      { resolveAsset },
    )
    expect(await page.locator("#s").textContent()).toBe(`f: ${asset}`)
    await run(
      `setup: [{ action: goto, url: /upload }]
steps: [{ id: avatar, action: upload, target: { by: role, role: button, name: Choose avatar }, file: ${asset} }]
`,
      { resolveAsset },
    )
    expect(await page.locator("#s").textContent()).toBe(`hidden: ${asset}`)
    const noResolver = await failure(`setup: [{ action: goto, url: /upload }]
steps: [{ id: attach, action: upload, target: { by: label, name: Attachment }, file: ${asset} }]
`)
    expect(noResolver.message).toMatch(/no asset resolver/)
    // A hidden file input, targeted through its label.
    await run(
      `setup: [{ action: goto, url: /upload }]
steps: [{ id: file, action: upload, target: { by: label, name: Avatar file }, file: ${asset} }]
`,
      { resolveAsset },
    )
    expect(await page.locator("#s").textContent()).toBe(`hid2: ${asset}`)
  })

  it("returns to the opener in the step that closed the popup (with the default settle)", async () => {
    await run(`overrides: { pacing: { settleMs: 400 } }
setup: [{ action: goto, url: /opener }]
steps:
  - { id: open, action: click, target: { by: role, role: button, name: Open popup } }
  - { id: done, action: click, target: { by: role, role: button, name: Done } }
  - { id: back, action: expect, that: { visible: { by: role, role: link, name: Open report } } }
`)
  })

  it("stays on the opener when a popup closes itself at once (OAuth with a session)", async () => {
    await run(`setup: [{ action: goto, url: /opener }]
steps:
  - { id: sso, action: click, target: { by: role, role: button, name: Sign in with provider } }
  - { id: still, action: expect, that: { visible: { by: role, role: link, name: Open report } } }
`)
  })

  it("follows a popup that opens after its step settled, from the next step on", async () => {
    await run(`setup: [{ action: goto, url: /opener }]
steps:
  - { id: later, action: click, target: { by: role, role: button, name: Open later } }
  - { id: wait, action: pause, ms: 1200 }
  - { id: seen, action: expect, that: { visible: { by: role, role: heading, name: Report } } }
`)
  })

  it("follows a new tab opened by a click, and returns when a popup closes itself", async () => {
    const switched: string[] = []
    const events = await run(
      `setup: [{ action: goto, url: /opener }]
steps:
  - { id: open, action: click, target: { by: role, role: button, name: Open popup } }
  - { id: seen, action: expect, that: { visible: { by: role, role: heading, name: Report } } }
  - { id: done, action: click, target: { by: role, role: button, name: Done } }
  - { id: back, action: expect, that: { visible: { by: role, role: link, name: Open report } } }
  - { id: tab, action: click, target: { by: role, role: link, name: Open report } }
  - { id: in-tab, action: expect, that: { visible: { by: role, role: heading, name: Report } } }
`,
      { onPageSwitch: (p) => void switched.push(new URL(p.url()).pathname) },
    )
    expect(switched).toEqual(["/popup-report", "/opener", "/popup-report"])
    const navigated = events.flatMap((e) =>
      e.kind === "navigate" ? [new URL(e.url).pathname] : [],
    )
    expect(navigated.filter((p) => p === "/popup-report").length).toBeGreaterThanOrEqual(2)
  })

  // ─── P0-9: state (ensure, teardown, session presets, hover) ────────────────

  const boardScene = (teardown = true) => `setup:
  - { action: goto, url: /boards }
  - ensure: { absent: { by: role, role: heading, name: Q4 roadmap } }
steps:
  - { id: new, action: click, target: { by: role, role: button, name: New board } }
  - { id: shown, action: expect, that: { visible: { by: role, role: heading, name: Q4 roadmap } } }
${
  teardown
    ? `teardown:
  - { action: hover, target: { by: role, role: heading, name: Q4 roadmap } }
  - { action: click, target: { by: role, role: button, name: Delete board }, risky: false }
`
    : ""
}`
  const seedBoard = async () => {
    await page.goto(`${server.url}/boards`)
    await page.evaluate(() => localStorage.setItem("boards", JSON.stringify(["Q4 roadmap"])))
  }
  const phases = (events: RunnerEvent[]) =>
    events.flatMap((e) => (e.kind === "step_start" ? [`${e.step.phase}:${e.step.action}`] : []))

  it("ensure absent: runs the teardown on leftovers, replays the setup, then films", async () => {
    await seedBoard()
    const events = await run(boardScene())
    expect(phases(events)).toEqual([
      "setup:goto",
      "setup:ensure",
      // leftovers from an earlier run: the teardown (hover reveals Delete), then setup again,
      // all inside the ensure step
      "setup:ensure: hover",
      "setup:ensure: click",
      "setup:ensure: goto",
      "steps:click",
      "steps:expect",
      // the scene's own cleanup
      "teardown:hover",
      "teardown:click",
    ])
    expect(await page.evaluate(() => localStorage.getItem("boards"))).toBe("[]")
  })

  it("ensure absent: nothing to do when it's already absent", async () => {
    const events = await run(boardScene())
    expect(phases(events).slice(0, 3)).toEqual(["setup:goto", "setup:ensure", "steps:click"])
  })

  it("ensure fails clearly when it can't be made true", async () => {
    await seedBoard()
    const noTeardown = await failure(boardScene(false))
    expect(noTeardown.reason).toBe("ensure-failed")
    expect(noTeardown.message).toMatch(/has no teardown/)
    const stubborn = await failure(`setup:
  - { action: goto, url: /boards }
  - ensure: { absent: { by: role, role: heading, name: Q4 roadmap } }
steps: [{ id: a, action: pause, ms: 1 }]
teardown: [{ action: pause, ms: 1 }]
`)
    expect(stubborn.message).toMatch(/still present after the teardown/)
    // A cleanup step that fails is the ensure's failure (setup), never a teardown failure: a take
    // with no step filmed must not pass as complete.
    await seedBoard()
    const cleanup = await failure(`setup:
  - { action: goto, url: /boards }
  - ensure: { absent: { by: role, role: heading, name: Q4 roadmap } }
steps: [{ id: a, action: pause, ms: 1 }]
teardown: [{ action: click, target: { by: role, role: button, name: Nowhere } }]
`)
    // ...keeping its own reason, and saying which cleanup step failed.
    expect(cleanup.reason).toBe("target-not-found")
    expect(cleanup.step).toMatchObject({ phase: "setup", action: "ensure" })
    expect(cleanup.message).toMatch(/removing .*Q4 roadmap.* \(teardown\), step 1 \(click\)/)
    const present = await failure(`setup:
  - { action: goto, url: /boards }
  - ensure: { present: { by: role, role: heading, name: Launch plan } }
steps: [{ id: a, action: pause, ms: 1 }]
`)
    expect(present.reason).toBe("ensure-failed")
    expect(present.message).toMatch(/must be present/)
  })

  it("after an ensure failure, doesn't run the teardown on data the scene didn't create", async () => {
    await seedBoard()
    const events: RunnerEvent[] = []
    await expect(
      runScenario(
        page,
        scenario(`setup:
  - { action: goto, url: /boards }
  - ensure: { present: { by: role, role: heading, name: Launch plan } }
steps: [{ id: a, action: pause, ms: 1 }]
teardown:
  - { action: hover, target: { by: role, role: heading, name: Q4 roadmap } }
  - { action: click, target: { by: role, role: button, name: Delete board }, risky: false }
`),
        project,
        { timeoutMs: 800, onEvent: (e) => events.push(e) },
      ),
    ).rejects.toThrow(/must be present/)
    expect(events.some((e) => e.kind === "step_start" && e.step.phase === "teardown")).toBe(false)
    // The pre-existing board is still there.
    expect(await page.evaluate(() => localStorage.getItem("boards"))).toBe('["Q4 roadmap"]')
  })

  it("keeps risky-not-approved when the ensure cleanup needs an approval", async () => {
    await seedBoard()
    const error = await failure(`setup:
  - { action: goto, url: /boards }
  - ensure: { absent: { by: role, role: heading, name: Q4 roadmap } }
steps: [{ id: a, action: pause, ms: 1 }]
teardown:
  - { action: hover, target: { by: role, role: heading, name: Q4 roadmap } }
  - { action: click, target: { by: role, role: button, name: Delete board }, risky: true }
`)
    expect(error.reason).toBe("risky-not-approved")
  })

  it("an ensure on a blank page fails clearly (nothing loaded is not 'absent')", async () => {
    const error = await failure(`setup:
  - ensure: { absent: { by: role, role: heading, name: Q4 roadmap } }
steps: [{ id: a, action: pause, ms: 1 }]
teardown: [{ action: pause, ms: 1 }]
`)
    expect(error.message).toMatch(/needs a page/)
  })

  it("runs a session preset once and reports it; skips it when the page already has it", async () => {
    const yaml = `setup: [{ preset: sign-in }, { action: goto, url: /boards }]
steps: [{ id: a, action: pause, ms: 1 }]
`
    const first = await run(yaml)
    expect(first.filter((e) => e.kind === "preset_done")).toEqual([
      { kind: "preset_done", name: "sign-in", session: true },
    ])
    const again = await run(yaml, { skipSessionPresets: ["sign-in"] })
    expect(again.some((e) => e.kind === "preset_done")).toBe(false)
    expect(phases(again)).toEqual(["setup:goto", "steps:pause"])
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

  // ─── Review round 5 (P0-3) ─────────────────────────────────────────────────

  it("never falls back past an ambiguous primary locator", async () => {
    const error = await failure(`steps:
  - { id: go, action: goto, url: /ambiguous }
  - { id: del, action: click, target: { by: role, role: button, name: Delete, fallbacks: [{ by: css, selector: span }] } }
`)
    expect(error.reason).toBe("target-ambiguous")
  })

  it("sees shadow-DOM elements as on screen", async () => {
    await run(
      `steps:
  - { id: go, action: goto, url: /shadow }
  - { id: find, action: scroll, until: { by: role, role: button, name: Inside shadow } }
`,
      { timeoutMs: 5000 },
    )
  })

  it("scrolls a mid-page pane back up to a target above its visible area", async () => {
    await run(
      `steps:
  - { id: go, action: goto, url: /pane }
  - { id: down, action: scroll, until: { by: text, text: Pane bottom }, within: { by: css, selector: "#pane" } }
  - { id: up, action: scroll, until: { by: text, text: Pane top }, within: { by: css, selector: "#pane" } }
`,
      { timeoutMs: 5000 },
    )
  })

  it("waits for lazily loaded content at the end of an infinite list", async () => {
    await run(
      `steps:
  - { id: go, action: goto, url: /feed }
  - { id: find, action: scroll, until: { by: text, text: Target item } }
`,
      { timeoutMs: 8000 },
    )
  }, 20_000)

  it("refuses to type a secret outside the target app's origin", async () => {
    await page.goto(server.url.replace("127.0.0.1", "localhost") + "/login")
    await page.setContent("<label>Password <input type=password></label>")
    const error = await failure(
      `steps:
  - { id: pw, action: type, target: { by: label, name: Password }, value: "{{secrets.acme.password}}" }
`,
      { resolveSecret: () => "hunter2" },
    )
    expect(error.reason).toBe("off-origin")
  })

  it("doesn't attach anything to the page when the setup is invalid", async () => {
    const on = vi.spyOn(page, "on")
    await expect(
      run(`setup: [{ preset: typo }]\nsteps: [{ id: a, action: pause, ms: 1 }]\n`),
    ).rejects.toThrow(/typo/)
    expect(on).not.toHaveBeenCalled()
    on.mockRestore()
  })

  // ─── Review round 6 (P0-3) ─────────────────────────────────────────────────

  it("types into email and number inputs (no selection API there)", async () => {
    await run(`steps:
  - { id: go, action: goto, url: /login-form }
  - { id: email, action: type, target: { by: label, name: Email }, value: bob@acme.com }
  - { id: age, action: type, target: { by: label, name: Age }, value: "42", instant: true }
`)
    expect(await page.getByLabel("Email").inputValue()).toBe("bob@acme.com")
    expect(await page.getByLabel("Age").inputValue()).toBe("42")
  })

  it("refuses to type into a target that can't take focus (no secret in the previous field)", async () => {
    const error = await failure(
      `steps:
  - { id: go, action: goto, url: /login-form }
  - { id: email, action: type, target: { by: label, name: Email }, value: bob@acme.com }
  - { id: pw, action: type, target: { by: css, selector: .password-field }, value: "{{secrets.acme.password}}" }
`,
      { resolveSecret: () => "hunter2" },
    )
    expect(error.message).toMatch(/can't take keyboard focus/)
    expect(await page.getByLabel("Email").inputValue()).toBe("bob@acme.com")
  })

  it("detects obvious risky buttons without `risky: true`", async () => {
    const error = await failure(`steps:
  - { id: go, action: goto, url: /login-form }
  - { id: del, action: click, target: { by: role, role: button, name: Delete project } }
`)
    expect(error.reason).toBe("risky-not-approved")
    await run(`steps:
  - { id: go, action: goto, url: /login-form }
  - { id: del, action: click, target: { by: role, role: button, name: Delete project }, risky: false }
  - { id: done, action: expect, that: { text: Deleted } }
`)
  })

  it("settles while a web component renders inside its shadow root", async () => {
    await run(`steps:
  - { id: go, action: goto, url: /shadow-render }
  - { id: load, action: click, target: { by: role, role: button, name: Load panel } }
  - { id: ready, action: expect, that: { text: Panel ready }, timeout: 50 }
`)
  })

  it("stops quickly on a target covered by a sticky header mid-page", async () => {
    const started = Date.now()
    const error = await failure(
      `steps:
  - { id: go, action: goto, url: /covered-mid }
  - { id: find, action: scroll, until: { by: text, text: Behind header } }
`,
      { timeoutMs: 8000 },
    )
    expect(error.message).toMatch(/stays off screen/)
    expect(Date.now() - started).toBeLessThan(6000)
  })

  it("names the teardown step that failed", async () => {
    const events: RunnerEvent[] = []
    await expect(
      runScenario(
        page,
        scenario(`setup: [{ preset: open-projects }]
steps:
  - { id: boom, action: click, target: { by: role, role: button, name: Missing } }
teardown:
  - { id: first, action: pause, ms: 1 }
  - { id: second, action: click, target: { by: role, role: button, name: Also missing } }
`),
        project,
        { timeoutMs: 300, onEvent: (e) => events.push(e) },
      ),
    ).rejects.toThrow(/boom/)
    const failed = events.find((e) => e.kind === "teardown_failed")
    expect(failed?.kind === "teardown_failed" && failed.error.step.index).toBe(1)
  })

  // ─── Review round 7 (P0-3) ─────────────────────────────────────────────────

  it("types into inputs inside shadow DOM", async () => {
    await run(`steps:
  - { id: go, action: goto, url: /wc-form }
  - { id: nick, action: type, target: { by: label, name: Nickname }, value: Bob }
`)
    expect(await page.getByLabel("Nickname").inputValue()).toBe("Bob")
  })

  it("detects risky submit inputs by their value, and doesn't flag a row containing a Delete button", async () => {
    const error = await failure(`steps:
  - { id: go, action: goto, url: /wc-form }
  - { id: rm, action: click, target: { by: role, role: button, name: Remove member } }
`)
    expect(error.reason).toBe("risky-not-approved")
    // This row's aim point lands on its Delete button: the press would delete, so it needs approval.
    const row = (risky: string) => `steps:
  - { id: go, action: goto, url: /wc-form }
  - { id: open, action: click, target: { by: role, role: row, name: Acme project Delete }${risky} }
`
    expect((await failure(row(""))).reason).toBe("risky-not-approved")
    await run(row(", risky: false"))
  })

  it("matches hash routes that carry their own query", async () => {
    await run(`steps:
  - { id: go, action: goto, url: "/projects#/projects?tab=members&x=1" }
  - { id: at, action: expect, that: { url: "/projects#/projects" } }
  - { id: tab, action: expect, that: { url: "/projects#/projects?tab=members" } }
`)
  })

  it("reports when a fallback locator had to be used", async () => {
    const events = await run(`setup: [{ preset: open-projects }]
steps:
  - { id: open, action: click, target: { by: role, role: button, name: Renamed, fallbacks: [{ by: text, text: New project }] } }
`)
    expect(events.find((e) => e.kind === "target_fallback")).toMatchObject({ fallbackIndex: 0 })
  })

  it("names the step when a callback throws", async () => {
    const error = await failure(
      `setup: [{ preset: open-projects }]\nsteps:\n  - { id: a, action: pause, ms: 1 }\n`,
      {
        onEvent: (e) => {
          if (e.kind === "step_start" && e.step.stepId === "a") throw new Error("listener broke")
        },
      },
    )
    expect(error.message).toMatch(/^steps\[0\] \(a, pause\): listener broke/)
  })

  // ─── Review round 8 (P0-3, cheap fixes before merge) ───────────────────────

  it("treats a click on the text inside a Delete button as risky", async () => {
    const error = await failure(`steps:
  - { id: go, action: goto, url: /wc-form }
  - { id: del, action: click, target: { by: css, selector: "button > span" } }
`)
    expect(error.reason).toBe("risky-not-approved")
  })

  // ─── P0-4: human motion ────────────────────────────────────────────────────

  it("moves the cursor along a path and clicks exactly where it stopped", async () => {
    const human = parseProjectYaml(`version: 1
target: { kind: web, url: "${server.url}", viewport: { width: 1280, height: 800 } }
defaults: { pacing: { settleMs: 0, cursor: natural, typing: human } }
`)
    const events: RunnerEvent[] = []
    await runScenario(
      page,
      scenario(`steps:
  - { id: go, action: goto, url: /projects }
  - { id: open-new, action: click, target: { by: role, role: button, name: New project } }
  - { id: name, action: type, target: { by: label, name: Project name }, value: "Q4 Launch" }
`),
      human,
      { timeoutMs: 3000, onEvent: (e) => events.push(e) },
    )
    const moves = events.filter(
      (e) => e.kind === "cursor" && e.step.stepId === "open-new" && !e.pressed,
    )
    expect(moves.length).toBeGreaterThan(5)
    const press = events.find((e) => e.kind === "cursor" && e.pressed)
    const last = moves.at(-1)
    expect(
      press && last && press.kind === "cursor" && last.kind === "cursor" && [press.x, press.y],
    ).toEqual(last && last.kind === "cursor" ? [last.x, last.y] : [])
    // The click worked (the form opened) and the text was typed in the human rhythm.
    expect(await page.getByLabel("Project name").inputValue()).toBe("Q4 Launch")
    const box = await page.getByRole("button", { name: "New project" }).boundingBox()
    expect(
      press?.kind === "cursor" && box && press.x >= box.x && press.x <= box.x + box.width,
    ).toBe(true)
  })

  it("moves the same way on every replay (seeded motion)", async () => {
    const human = parseProjectYaml(`version: 1
target: { kind: web, url: "${server.url}", viewport: { width: 1280, height: 800 } }
defaults: { pacing: { settleMs: 0, cursor: fast, typing: instant } }
`)
    const replay = async () => {
      const p = await browser.newPage({ viewport: { width: 1280, height: 800 } })
      const events: RunnerEvent[] = []
      await runScenario(
        p,
        scenario(`steps:
  - { id: go, action: goto, url: /projects }
  - { id: open-new, action: click, target: { by: role, role: button, name: New project } }
`),
        human,
        { onEvent: (e) => events.push(e) },
      )
      await p.close()
      return events.flatMap((e) =>
        e.kind === "cursor" ? [[Math.round(e.x), Math.round(e.y)]] : [],
      )
    }
    expect(await replay()).toEqual(await replay())
  })

  // ─── P0-4 review round 1 (regressions) ─────────────────────────────────────

  const humanProject = () =>
    parseProjectYaml(`version: 1
target: { kind: web, url: "${server.url}", viewport: { width: 1280, height: 800 } }
defaults: { pacing: { settleMs: 0, cursor: fast, typing: instant } }
`)

  it("still hits a target that moves while the cursor travels", async () => {
    await runScenario(
      page,
      scenario(`steps:
  - { id: go, action: goto, url: /moving }
  - { id: hit, action: click, target: { by: role, role: button, name: Moving target } }
  - { id: ok, action: expect, that: { text: Hit } }
`),
      humanProject(),
      { timeoutMs: 3000 },
    )
  })

  it("aims inside the visible part of an element taller than the viewport", async () => {
    const events: RunnerEvent[] = []
    await runScenario(
      page,
      scenario(`steps:
  - { id: go, action: goto, url: /tall }
  - { id: board, action: click, target: { by: role, role: region, name: Board } }
`),
      humanProject(),
      { timeoutMs: 3000, onEvent: (e) => events.push(e) },
    )
    const press = events.find((e) => e.kind === "cursor" && e.pressed)
    expect(press?.kind === "cursor" && press.y >= 0 && press.y < 800).toBe(true)
    await expect(page.getByText(/^Board \d+/).isVisible()).resolves.toBe(true)
  })

  it("fails closed on a link card whose accessible name contains Delete (risky: false opts out)", async () => {
    const card = (risky: string) => `steps:
  - { id: go, action: goto, url: /cards }
  - { id: open, action: click, target: { by: text, text: Acme project }${risky} }
  - { id: at, action: expect, that: { url: "/cards#opened" } }
`
    expect((await failure(card(""))).reason).toBe("risky-not-approved")
    await run(card(", risky: false"))
  })

  it("releases the cursor even when the click fails", async () => {
    const events: RunnerEvent[] = []
    // A disabled button: the probe hits it, Playwright's click waits for "enabled" and times out.
    await page.setContent(`<button id="b" disabled style="width:200px; height:60px">Save</button>`)
    await expect(
      runScenario(
        page,
        scenario(
          `steps:\n  - { id: hit, action: click, target: { by: css, selector: "#b" }, risky: false }\n`,
        ),
        humanProject(),
        { timeoutMs: 800, onEvent: (e) => events.push(e) },
      ),
    ).rejects.toThrow(/Timeout/)
    // The press is reported, the click fails, the release is reported anyway: nothing left held.
    const pressed = events.flatMap((e) => (e.kind === "cursor" ? [e.pressed] : []))
    // Movement samples are pressed: false too, so count transitions: every press is released.
    const presses = pressed.filter((p, i) => p && pressed[i - 1] !== true).length
    const releases = pressed.filter((p, i) => !p && pressed[i - 1] === true).length
    expect(presses).toBe(1)
    expect(releases).toBe(1)
    expect(pressed.at(-1) ?? false).toBe(false)
  })

  // ─── P0-4 review round 2 (regressions) ─────────────────────────────────────

  it("labels controls from their visible text, wrappers from what they wrap", async () => {
    for (const target of [
      "{ by: role, role: menuitem, name: Delete }",
      "{ by: css, selector: '#trash' }",
    ]) {
      const error = await failure(
        `steps:\n  - { id: go, action: goto, url: /labels }\n  - { id: c, action: click, target: ${target} }\n`,
      )
      expect(error.reason).toBe("risky-not-approved")
    }
    // Fail closed: hidden text that mentions Delete counts too.
    expect(
      (
        await failure(
          `steps:\n  - { id: go, action: goto, url: /labels }\n  - { id: save, action: click, target: { by: css, selector: "#save" } }\n`,
        )
      ).reason,
    ).toBe("risky-not-approved")
    await run(`steps:
  - { id: go, action: goto, url: /labels }
  - { id: save, action: click, target: { by: css, selector: "#save" }, risky: false }
  - { id: ok, action: expect, that: { text: Saved it } }
`)
  })

  it("clicks where the cursor pressed on a board scrolled past its top", async () => {
    const events: RunnerEvent[] = []
    await runScenario(
      page,
      scenario(`steps:
  - { id: go, action: goto, url: /tall }
  - { id: down, action: scroll, by: { y: 900 } }
  - { id: board, action: click, target: { by: role, role: region, name: Board } }
`),
      humanProject(),
      { timeoutMs: 3000, onEvent: (e) => events.push(e) },
    )
    const press = events.find((e) => e.kind === "cursor" && e.pressed)
    const clicked = Number((await page.getByText(/^Board \d+/).textContent())?.split(" ")[1])
    expect(press?.kind === "cursor" && Math.abs(press.y - clicked) < 2).toBe(true)
  })

  it("reports one press/release pair per click of a double click", async () => {
    const events: RunnerEvent[] = []
    await runScenario(
      page,
      scenario(`steps:
  - { id: go, action: goto, url: /projects }
  - { id: dbl, action: click, count: 2, target: { by: role, role: button, name: New project } }
`),
      humanProject(),
      { onEvent: (e) => events.push(e) },
    )
    const pressed = events.flatMap((e) =>
      e.kind === "cursor" && e.step.stepId === "dbl" ? [e.pressed] : [],
    )
    const transitions = pressed.filter((p, i) => i > 0 && p !== pressed[i - 1])
    expect(transitions).toEqual([true, false, true, false])
  })

  it("finishes teardown after a step failed with a pending listener error", async () => {
    const events: RunnerEvent[] = []
    await expect(
      runScenario(
        page,
        scenario(`steps:
  - { id: go, action: goto, url: /projects }
  - { id: boom, action: click, target: { by: role, role: button, name: Missing } }
teardown:
  - { id: t1, action: pause, ms: 1 }
  - { id: t2, action: pause, ms: 1 }
`),
        project,
        {
          timeoutMs: 300,
          onEvent: (e) => {
            events.push(e)
            if (e.kind === "navigate") throw new Error("recorder closed")
          },
        },
      ),
    ).rejects.toThrow()
    expect(events.some((e) => e.kind === "step_end" && e.step.stepId === "t2")).toBe(true)
  })

  // ─── P0-4 review round 3 (label regressions) ───────────────────────────────

  it("labels split words, display:contents and visibility like the browser does", async () => {
    for (const id of ["split", "contents"]) {
      const error = await failure(
        `steps:\n  - { id: go, action: goto, url: /labels }\n  - { id: c, action: click, target: { by: css, selector: "#${id}" } }\n`,
      )
      expect(error.reason).toBe("risky-not-approved")
    }
    await run(`steps:
  - { id: go, action: goto, url: /labels }
  - { id: vis, action: click, target: { by: css, selector: "#vis" }, risky: false }
  - { id: ok, action: expect, that: { text: Saved vis } }
`)
  })

  it("names an image card from its alt text, and fails closed on its nested Delete", async () => {
    const card = (risky: string) => `steps:
  - { id: go, action: goto, url: /labels }
  - { id: open, action: click, target: { by: css, selector: "#thumbcard img" }${risky} }
  - { id: at, action: expect, that: { url: "/labels#thumb" } }
`
    const error = await failure(card(""))
    expect(error.message).toMatch(/mentions "Delete"/)
    await run(card(", risky: false"))
  })

  it("clicks exactly on the pressed point of a bordered element", async () => {
    const events: RunnerEvent[] = []
    await runScenario(
      page,
      scenario(`steps:
  - { id: go, action: goto, url: /labels }
  - { id: b, action: click, target: { by: css, selector: "#bordered" } }
`),
      humanProject(),
      { onEvent: (e) => events.push(e) },
    )
    const press = events.find((e) => e.kind === "cursor" && e.pressed)
    const [x, y] = ((await page.getByText(/^B \d/).textContent()) ?? "")
      .slice(2)
      .split(",")
      .map(Number)
    expect(
      press?.kind === "cursor" &&
        Math.abs(press.x - (x ?? 0)) <= 1 &&
        Math.abs(press.y - (y ?? 0)) <= 1,
    ).toBe(true)
  })

  // ─── P0-4 review round 4: accessible names, failing closed ─────────────────

  it("flags risky controls by their accessible name in every DOM shape", async () => {
    await page.setContent(`
      <a href="#d" id="nested">Delete draft <span role="button"><button>Delete</button></span></a>
      <button id="hidden-child">Delete file<span role="button" style="display:none">Delete</span></button>
      <ul><li role="menuitem" id="icon-item"><svg width="8" height="8"></svg><a href="#">Delete</a></li></ul>
      <input type="image" id="img-input" alt="Delete" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
      <button id="img-button"><img alt="Remove" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="10" height="10"></button>`)
    for (const id of ["nested", "hidden-child", "icon-item", "img-input", "img-button"]) {
      const error = await failure(
        `steps:\n  - { id: c, action: click, target: { by: css, selector: "#${id}" } }\n`,
      )
      expect(error.reason, id).toBe("risky-not-approved")
    }
  })

  // ─── P0-4 review round 5: every label source, failing closed ───────────────

  it("fails closed on quoted names, aria-hidden content, links without href and odd input types", async () => {
    await page.setContent(`
      <button id="hash">Delete item #42</button>
      <button id="colon">Delete: permanently</button>
      <div aria-hidden="true"><button id="hidden-toolbar">Delete</button></div>
      <a id="nohref" onclick="void 0">Delete</a>
      <input id="upper" type="Submit" value="Delete">`)
    for (const id of ["hash", "colon", "hidden-toolbar", "nohref", "upper"]) {
      const error = await failure(
        `steps:\n  - { id: c, action: click, target: { by: css, selector: "#${id}" } }\n`,
      )
      expect(error.reason, id).toBe("risky-not-approved")
    }
  })

  it("doesn't truncate before looking for risky words", async () => {
    await page.setContent(`<button id="long">${"Very long description ".repeat(20)}Send</button>`)
    const error = await failure(
      `steps:\n  - { id: c, action: click, target: { by: css, selector: "#long" } }\n`,
    )
    expect(error.reason).toBe("risky-not-approved")
  })

  // ─── P0-4 review round 6: clicks at the cursor by construction ─────────────

  it("fails closed on names hidden behind other attributes", async () => {
    await page.setContent(`
      <button id="title"><span aria-label="Trash" title="Delete forever">🗑</span></button>
      <button id="alt"><img alt="" aria-label="Delete" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="10" height="10"></button>`)
    for (const id of ["title", "alt"]) {
      const error = await failure(
        `steps:\n  - { id: c, action: click, target: { by: css, selector: "#${id}" } }\n`,
      )
      expect(error.reason, id).toBe("risky-not-approved")
    }
  })

  it("reports the release of a successful click even if the release callback throws", async () => {
    const error = await failure(
      `setup: [{ preset: open-projects }]
steps:
  - { id: open, action: click, target: { by: role, role: button, name: New project } }
`,
      {
        onEvent: (e) => {
          if (e.kind === "cursor" && !e.pressed && e.step.stepId === "open" && seenPress)
            throw new Error("recorder closed")
          if (e.kind === "cursor" && e.pressed) seenPress = true
        },
      },
    )
    expect(error.message).toMatch(/recorder closed/)
  })
  let seenPress = false

  // ─── P0-4 review round 7: the risky check at the press point ───────────────

  it("reads the label at press time, after hover changed it", async () => {
    await page.setContent(
      `<button id="follow" onmouseenter="this.textContent='Remove follow'">Following</button>`,
    )
    const error = await failure(
      `steps:\n  - { id: c, action: click, target: { by: css, selector: "#follow" } }\n`,
    )
    expect(error.reason).toBe("risky-not-approved")
  })

  it("accepts a hit on a layer inside the target's button", async () => {
    await page.setContent(`
      <button id="save" style="position:relative; width:200px; height:60px" onclick="document.body.dataset.saved='1'">
        <span id="text">Save</span>
        <span style="position:absolute; inset:0; background:transparent"></span>
      </button>`)
    await run(`steps:\n  - { id: c, action: click, target: { by: css, selector: "#text" } }\n`)
    expect(await page.evaluate<string | undefined>("document.body.dataset.saved")).toBe("1")
  })

  it("judges a card click by what the press activates, not by the card's other buttons", async () => {
    await page.setContent(`
      <div id="card" style="width:600px; height:200px; position:relative" onclick="document.body.dataset.opened='1'">
        <h3 id="title" style="margin:0; height:200px; width:400px">Acme project</h3>
        <button style="position:absolute; right:0; top:0" onclick="event.stopPropagation()">Delete</button>
      </div>`)
    await run(`steps:\n  - { id: open, action: click, target: { by: css, selector: "#title" } }\n`)
    expect(await page.evaluate<string | undefined>("document.body.dataset.opened")).toBe("1")
  })

  it("runs every teardown step even when one fails", async () => {
    const events: RunnerEvent[] = []
    await expect(
      runScenario(
        page,
        scenario(`setup: [{ preset: open-projects }]
steps: [{ id: a, action: pause, ms: 1 }]
teardown:
  - { id: t1, action: click, target: { by: role, role: button, name: Missing } }
  - { id: t2, action: pause, ms: 1 }
`),
        project,
        { timeoutMs: 300, onEvent: (e) => events.push(e) },
      ),
    ).rejects.toThrow(/t1/)
    expect(events.some((e) => e.kind === "step_end" && e.step.stepId === "t2")).toBe(true)
  })

  // ─── P0-4 review round 8 ───────────────────────────────────────────────────

  it("doesn't count the human approval wait against the click's time budget", async () => {
    await page.setContent(`<button onclick="document.body.dataset.done='1'">Delete draft</button>`)
    await run(
      `steps:\n  - { id: del, action: click, target: { by: role, role: button, name: Delete draft } }\n`,
      {
        timeoutMs: 500,
        approveRisky: () => new Promise((resolve) => setTimeout(() => resolve(true), 1200)),
      },
    )
    expect(await page.evaluate<string | undefined>("document.body.dataset.done")).toBe("1")
  })

  it("doesn't press if the page changed during the approval", async () => {
    await page.setContent(
      `<button id="b" onclick="document.body.dataset.done='1'">Delete draft</button>`,
    )
    const error = await failure(
      `steps:\n  - { id: del, action: click, target: { by: css, selector: "#b" } }\n`,
      {
        approveRisky: async () => {
          await page.evaluate(() => {
            document.getElementById("b")!.textContent = "Send invite"
          })
          return true
        },
      },
    )
    expect(error.message).toMatch(/page changed while waiting for approval/)
    expect(await page.evaluate<string | undefined>("document.body.dataset.done")).toBeUndefined()
  })

  it("judges a press on a card's background by the card's own text only", async () => {
    await page.setContent(`
      <div id="card" style="width:600px; height:300px; padding:40px" onclick="document.body.dataset.opened='1'">
        Acme project
        <button onclick="event.stopPropagation()">Delete</button>
      </div>`)
    await run(`steps:\n  - { id: open, action: click, target: { by: css, selector: "#card" } }\n`)
    expect(await page.evaluate<string | undefined>("document.body.dataset.opened")).toBe("1")
  })

  // ─── P0-4 review round 9: back to Playwright's click ───────────────────────

  it("clicks a shadow-DOM button whose label is slotted, and flags it", async () => {
    await page.setContent(`
      <my-button><span>Delete</span></my-button>
      <script>
        customElements.define("my-button", class extends HTMLElement {
          connectedCallback() {
            this.attachShadow({ mode: "open" }).innerHTML =
              "<button onclick=\\"document.body.dataset.done='1'\\"><slot></slot></button>"
          }
        })
      </script>`)
    const flagged = await failure(
      `steps:\n  - { id: c, action: click, target: { by: role, role: button, name: Delete } }\n`,
    )
    expect(flagged.reason).toBe("risky-not-approved")
    await run(
      `steps:\n  - { id: c, action: click, target: { by: role, role: button, name: Delete }, risky: false }\n`,
    )
    expect(await page.evaluate<string | undefined>("document.body.dataset.done")).toBe("1")
  })

  it("waits for the navigation a click starts before the next step", async () => {
    await run(`steps:
  - { id: go, action: goto, url: / }
  - { id: open, action: click, target: { by: role, role: link, name: Projects } }
  - { id: at, action: expect, that: { url: /projects }, timeout: 50 }
`)
  })

  // ─── P0-4 review round 10 (cheap hardening before merge) ───────────────────

  it("fails closed on outer controls, the target's own title and split words outside controls", async () => {
    await page.setContent(`
      <div role="button" aria-label="Delete row" id="outer"><span role="button" id="inner">Open</span></div>
      <div class="trash" id="trash" title="Delete" style="width:40px; height:40px"><svg width="40" height="40"><rect width="40" height="40"/></svg></div>
      <div id="split" style="width:120px; height:30px"><b>Del</b>ete</div>`)
    for (const id of ["inner", "trash", "split"]) {
      const error = await failure(
        `steps:\n  - { id: c, action: click, target: { by: css, selector: "#${id}" } }\n`,
      )
      expect(error.reason, id).toBe("risky-not-approved")
    }
  })
})
