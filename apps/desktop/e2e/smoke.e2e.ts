// The built app, launched as a user would get it (a throwaway profile, the key in memory): the
// first run asks for the key, then for a project; the window is hardened.
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createProject, saveScene } from "@kiframe/project"
import { parseScenarioYaml } from "@kiframe/schema"
import { _electron as electron, type ElectronApplication, type Page } from "playwright"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { startFixtureServer } from "../../../packages/runtime/test/fixture-server.ts"
import { processes, role, treeOf } from "../../../scripts/perf/procs.ts"

const appDir = join(import.meta.dirname, "..")
const shots = process.env.KIFRAME_E2E_SHOTS
let server: Awaited<ReturnType<typeof startFixtureServer>>
/** A step the scripted model runs. */
const step = (id: string, s: object) => ({
  kind: "tool_calls",
  calls: [{ id, name: "run_step", arguments: JSON.stringify({ scene: "login", step: s }) }],
})
/** A risky click the scripted model asks for: once stopped, once approved. */
const riskyCall = (id: string) => ({
  kind: "tool_calls",
  calls: [
    {
      id,
      name: "run_step",
      arguments: JSON.stringify({
        scene: "tour",
        step: {
          id: "open",
          action: "click",
          target: { by: "role", role: "link", name: "Projects" },
          risky: true,
        },
      }),
    },
  ],
})
let app: ElectronApplication
let page: Page
/** What the window's console reported (a CSP refusal shows there). */
const consoleErrors: string[] = []

beforeAll(async () => {
  const profile = mkdtempSync(join(tmpdir(), "kiframe-e2e-"))
  // The dev server is never used: the built window, as shipped.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (e): e is [string, string] =>
        e[1] !== undefined && e[0] !== "ELECTRON_RENDERER_URL" && e[0] !== "ELECTRON_RUN_AS_NODE",
    ),
  )
  env.KIFRAME_TEST_KEYCHAIN = "memory"
  // The model, scripted: the first run is stopped at its approval, the second approved.
  server = await startFixtureServer()
  const model = join(profile, "model.json")
  writeFileSync(
    model,
    JSON.stringify([
      riskyCall("c1"),
      riskyCall("c2"),
      { kind: "text", text: "Opened your projects." },
      step("c3", { id: "go", action: "goto", url: "/login-form" }),
      step("c4", {
        id: "pw",
        action: "type",
        target: { by: "label", name: "Password input" },
        value: "{{secrets.acme.password}}",
      }),
      { kind: "text", text: "Signed in." },
      // A long chat (more than the window holds).
      ...Array.from({ length: 14 }, (_, i) => ({ kind: "text", text: `Noted ${i}.` })),
      // Steps that take a while, then a question: read back while they run.
      step("w1", { id: "w1", action: "pause", ms: 1500 }),
      step("w2", { id: "w2", action: "pause", ms: 1500 }),
      {
        kind: "tool_calls",
        calls: [
          { id: "q1", name: "ask_user", arguments: JSON.stringify({ question: "Which account?" }) },
        ],
      },
      { kind: "text", text: "Got it." },
      { kind: "text", text: "Pinned again." },
      // After the project is closed and opened again: a step in a new browser.
      step("c9", { id: "home", action: "goto", url: "/" }),
      { kind: "text", text: "Back home." },
    ]),
  )
  env.KIFRAME_TEST_MODEL = model
  app = await electron.launch({
    args: [appDir, `--user-data-dir=${profile}`],
    cwd: appDir,
    env,
  })
  page = await app.firstWindow()
  page.on("console", (m) => {
    if (m.type() === "error" || /Content Security Policy/.test(m.text()))
      consoleErrors.push(m.text())
  })
})

afterAll(async () => {
  await app?.close()
  await server?.close()
})

describe("the desktop app", () => {
  it("asks for the OpenRouter key, then for a project", async () => {
    await expect
      .poll(() => page.getByRole("heading", { name: "Connect a model" }).isVisible())
      .toBe(true)
    if (shots !== undefined) await page.screenshot({ path: join(shots, "key-setup.png") })
    await page.getByLabel("OpenRouter API key").fill("sk-or-test-not-a-real-key")
    await page.getByRole("button", { name: "Save key" }).click()
    await expect
      .poll(() => page.getByRole("heading", { name: "Start a demo" }).isVisible())
      .toBe(true)
    // The key never comes back to the window.
    expect(await page.content()).not.toContain("sk-or-test-not-a-real-key")
    if (shots !== undefined) await page.screenshot({ path: join(shots, "project-start.png") })
  })

  it("opens a project the user picks, its scenes in story order with their status", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "kiframe-e2e-project-")), "demo.kiframe")
    const project = createProject(dir, {
      id: "p1",
      name: "Acme Billing demo",
      url: "https://app.acme.example",
    })
    saveScene(project, {
      version: 1,
      id: "intro",
      title: "Intro",
      source: { kind: "card", template: "title", content: { heading: "Acme Billing" } },
      duration: { mode: "auto" },
    })
    saveScene(
      project,
      {
        version: 1,
        id: "create-invoice",
        title: "Create an invoice",
        source: { kind: "recording" },
        duration: { mode: "auto" },
      },
      { scenario: parseScenarioYaml("version: 1\nsteps: [{ id: a, action: pause, ms: 1 }]\n") },
    )
    // The folder picker answers with the project (main's dialog, stubbed in main).
    await app.evaluate(({ dialog }, picked) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [picked] })
    }, dir)
    await page.getByRole("button", { name: "Open a project…" }).click()
    const strip = page.getByRole("region", { name: "Scenes" })
    await expect
      .poll(() => strip.getByRole("button").allInnerTexts())
      .toEqual([
        expect.stringMatching(/Intro[\s\S]*Title card/),
        expect.stringMatching(/Create an invoice[\s\S]*Grounded/),
      ])
    expect(await page.getByRole("button", { name: /Acme Billing demo/ }).isVisible()).toBe(true)
    if (shots !== undefined) await page.screenshot({ path: join(shots, "workspace.png") })
  })

  it("keeps the scene strip in the window at its smallest, and hidden elements hidden", async () => {
    const size = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.getSize(),
    )
    try {
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.setSize(1024, 680),
      )
      // A preview's canvas is as large as the video (1080p): the strip below it stays in view.
      const layout = await page.evaluate(async () => {
        const well = document.querySelector(".stage-well")
        const canvas = document.createElement("canvas")
        canvas.width = 1920
        canvas.height = 1080
        well?.append(canvas)
        const hidden = document.createElement("div")
        hidden.className = "player"
        hidden.hidden = true
        well?.append(hidden)
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
        const strip = document.querySelector(".strip")?.getBoundingClientRect()
        const out = {
          stripInWindow: strip !== undefined && strip.bottom <= window.innerHeight + 1,
          // A class's own display (the preview player's flex) never shows a hidden element.
          hiddenShown: getComputedStyle(hidden).display !== "none",
        }
        canvas.remove()
        hidden.remove()
        return out
      })
      expect(layout).toEqual({ stripInWindow: true, hiddenShown: false })
    } finally {
      await app.evaluate(({ BrowserWindow }, s) => {
        const [w = 1440, h = 900] = s ?? []
        BrowserWindow.getAllWindows()[0]?.setSize(w, h)
      }, size)
    }
  })

  it("runs the agent: a risky step asks in the chat, and Stop closes it with nothing more run", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "kiframe-e2e-app-")), "app.kiframe")
    createProject(dir, { id: "p2", name: "Fixture app", url: server.url })
    await app.evaluate(({ dialog }, picked) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [picked] })
    }, dir)
    await page.getByRole("button", { name: /Acme Billing demo/ }).click()
    await page.getByRole("menuitem", { name: "Open another project…" }).click()
    await expect
      .poll(() => page.getByRole("button", { name: /Fixture app/ }).isVisible())
      .toBe(true)
    const box = page.getByLabel("Message the agent")
    const idle = (await page.locator(".composer").boundingBox())?.height ?? -1
    await box.fill("Open the projects page")
    await box.press("Enter")
    const card = page.getByLabel("Approve a risky step?")
    // Running, the composer's box keeps its height (nothing in the window moves).
    await expect.poll(() => page.locator(".composer.working").count()).toBe(1)
    const working = (await page.locator(".composer.working").boundingBox())?.height ?? -1
    expect(Math.abs(working - idle)).toBeLessThanOrEqual(1)
    // Taken: the composer is the status bar, and nothing says it was refused.
    await expect.poll(() => page.getByRole("button", { name: "Stop" }).isVisible()).toBe(true)
    expect(await page.locator(".composer-refused").count()).toBe(0)
    await expect.poll(() => card.isVisible(), { timeout: 30_000 }).toBe(true)
    expect(await card.textContent()).toMatch(/scene tour/)
    if (shots !== undefined) await page.screenshot({ path: join(shots, "agent-approval.png") })
    await page.getByRole("button", { name: "Stop" }).click()
    await expect.poll(() => card.textContent()).toMatch(/Closed: the run stopped/)
    await expect.poll(() => page.getByText("Stopped. Nothing more ran.").isVisible()).toBe(true)
    expect(await page.getByRole("button", { name: "Approve this step" }).count()).toBe(0)
  })

  it("runs the step once approved, and shows the agent's browser in the live app", async () => {
    const box = page.getByLabel("Message the agent")
    await box.fill("Try again")
    await box.press("Enter")
    const approve = page.getByRole("button", { name: "Approve this step" })
    await expect.poll(() => approve.isVisible(), { timeout: 30_000 }).toBe(true)
    await approve.click()
    await expect
      .poll(() => page.getByText("Opened your projects.").isVisible(), { timeout: 30_000 })
      .toBe(true)
    // The composer is back, empty, and says nothing was refused.
    expect(await page.getByLabel("Message the agent").inputValue()).toBe("")
    expect(await page.locator(".composer-refused").count()).toBe(0)
    const frame = page.getByRole("img", { name: /The live app at/ })
    await expect.poll(() => frame.isVisible()).toBe(true)
    expect(await frame.getAttribute("alt")).toMatch(/\/projects/)
    if (shots !== undefined) await page.screenshot({ path: join(shots, "agent-live.png") })
  })

  it("keeps a secret the user adds, and asks before a step types it, the field outlined", async () => {
    await page.getByRole("button", { name: "Secrets" }).click()
    const panel = page.getByRole("dialog", { name: "Secrets" })
    await panel.getByLabel("Name").fill("acme.password")
    await panel.getByLabel("Value").fill("hunter2-e2e-secret")
    await panel.getByRole("button", { name: "Add secret" }).click()
    await expect
      .poll(() => panel.getByText("acme.password", { exact: true }).isVisible())
      .toBe(true)
    expect(await page.content()).not.toContain("hunter2-e2e-secret")
    await panel.getByRole("button", { name: "Close" }).click()
    const box = page.getByLabel("Message the agent")
    await box.fill("Sign in")
    await box.press("Enter")
    const dialog = page.getByRole("dialog", { name: "Type a secret here?" })
    await expect.poll(() => dialog.isVisible(), { timeout: 30_000 }).toBe(true)
    expect(await dialog.textContent()).toMatch(/Password input · an input of type password/)
    expect(await dialog.getByTestId("secret-outline").isVisible()).toBe(true)
    if (shots !== undefined) await page.screenshot({ path: join(shots, "secret-approval.png") })
    await dialog.getByRole("button", { name: "Allow here" }).click()
    await expect
      .poll(() => page.getByText("Signed in.").isVisible(), { timeout: 30_000 })
      .toBe(true)
    expect(await page.content()).not.toContain("hunter2-e2e-secret")
  })

  it("keeps the chat's log at its end as it grows, and the window itself never scrolls", async () => {
    // Every frame while the chat grows (the composer swapped for the status bar and back 14
    // times): the log at its end, the window's root and title bar where they are.
    await page.evaluate(() => {
      const w = window as unknown as { worst: number[]; sampling: boolean }
      w.worst = [0, 0, 0, 0]
      w.sampling = true
      const tick = () => {
        const log = document.querySelector(".chat-body")
        const items = log?.firstElementChild
        if (log !== null && log !== undefined && items !== null && items !== undefined) {
          const now = [
            items.getBoundingClientRect().bottom - log.getBoundingClientRect().bottom,
            document.scrollingElement?.scrollTop ?? 0,
            document.querySelector(".app")?.scrollTop ?? 0,
            Math.abs(document.querySelector(".titlebar")?.getBoundingClientRect().top ?? 0),
          ]
          w.worst = w.worst.map((v, k) => Math.max(v, now[k] ?? 0))
        }
        if (w.sampling) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    const box = page.getByLabel("Message the agent")
    for (let i = 0; i < 14; i++) {
      await box.fill(`Note ${i}`)
      await box.press("Enter")
      await expect.poll(() => page.getByText(`Noted ${i}.`).isVisible()).toBe(true)
    }
    const worst = await page.evaluate(() => {
      const w = window as unknown as { worst: number[]; sampling: boolean }
      w.sampling = false
      return w.worst
    })
    expect(worst.map((v) => Math.round(v))).toEqual([0, 0, 0, 0])
    // Code that would scroll the root (scrollIntoView, a scrollTop set) can't.
    const root = await page.evaluate(() => {
      const items = document.querySelectorAll(".chat-items > *")
      items[0]?.scrollIntoView({ block: "end" })
      items[items.length - 1]?.scrollIntoView({ block: "end" })
      if (document.scrollingElement !== null) document.scrollingElement.scrollTop = 200
      return [
        document.scrollingElement?.scrollTop ?? -1,
        document.querySelector(".app")?.scrollTop ?? -1,
        document.querySelector(".titlebar")?.getBoundingClientRect().top ?? -1,
      ]
    })
    expect(root).toEqual([0, 0, 0])
  })

  it("leaves a reader where they scrolled to (keys too), but shows what the run waits on", async () => {
    const log = page.getByRole("log", { name: "Messages" })
    const fromEnd = () =>
      log.evaluate((l) => {
        const items = l.firstElementChild
        return items === null
          ? -1
          : items.getBoundingClientRect().bottom - l.getBoundingClientRect().bottom
      })
    /** The top of the first item the reader sees (marked), on screen. */
    const markSeen = () =>
      log.evaluate((l) => {
        const top = l.getBoundingClientRect().top
        for (const old of l.querySelectorAll("[data-seen]")) old.removeAttribute("data-seen")
        const seen = [...l.querySelectorAll(".chat-items > *")].find(
          (e) => e.getBoundingClientRect().top >= top,
        )
        seen?.setAttribute("data-seen", "")
        return seen?.getBoundingClientRect().top ?? -1
      })
    const seenTop = () =>
      log.evaluate((l) => l.querySelector("[data-seen]")?.getBoundingClientRect().top ?? -1)
    const inView = (selector: string) =>
      log.evaluate((l, sel) => {
        const els = l.querySelectorAll(sel)
        const el = els[els.length - 1]
        if (el === undefined) return false
        const a = el.getBoundingClientRect()
        const b = l.getBoundingClientRect()
        return a.top >= b.top - 1 && a.bottom <= b.bottom + 1
      }, selector)
    const window0 = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.getSize(),
    )
    const resize = (dh: number) =>
      app.evaluate(({ BrowserWindow }, d) => {
        const w = BrowserWindow.getAllWindows()[0]
        const [width = 0, height = 0] = w?.getSize() ?? []
        w?.setSize(width, height + d)
      }, dh)
    const frames = () =>
      page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    try {
      // Steps running: the reader goes back with the keys; new rows come in below, unseen.
      const box = page.getByLabel("Message the agent")
      await box.fill("Check then ask")
      await box.press("Enter")
      await expect
        .poll(() => page.locator(".tool-status.spin").count(), { timeout: 30_000 })
        .toBeGreaterThan(0)
      // Keys scroll smoothly: the position read once it has settled.
      const settled = async () => {
        let last = Number.NaN
        await expect
          .poll(async () => {
            const now = await log.evaluate((l) => l.scrollTop)
            const still = now === last
            last = now
            return still
          })
          .toBe(true)
      }
      // Pressed until it has left the end (a smooth scroll a new row lands on may stop short: a
      // reader presses again).
      for (let i = 0; i < 5 && (await fromEnd()) <= 40; i++) {
        await log.press("PageUp")
        await page.waitForTimeout(300)
      }
      await expect.poll(fromEnd).toBeGreaterThan(40)
      await settled()
      const top = await markSeen()
      await expect
        .poll(() => page.getByText(/^2 steps/).count(), { timeout: 30_000 })
        .toBeGreaterThan(0)
      expect(Math.abs((await seenTop()) - top)).toBeLessThanOrEqual(1)
      // The question the run waits on comes into view, scrolled up or not.
      await expect.poll(() => inView(".request-card"), { timeout: 30_000 }).toBe(true)
      await page.getByPlaceholder("Your answer").fill("The demo one")
      await page.getByRole("button", { name: "Answer" }).click()
      await expect.poll(() => page.getByText("Got it.").isVisible(), { timeout: 30_000 }).toBe(true)
      // At the end, the window resized: still at the end.
      await resize(-60)
      await frames()
      expect(Math.round(await fromEnd())).toBe(0)
      // Scrolled back, resized again: the reader's place kept.
      await log.hover()
      await page.mouse.wheel(0, -600)
      await expect.poll(fromEnd).toBeGreaterThan(40)
      await settled()
      const before = await markSeen()
      await resize(30)
      await frames()
      expect(Math.abs((await seenTop()) - before)).toBeLessThanOrEqual(1)
      // Sending takes the log back to its end, the message in view.
      await box.fill("again")
      await box.press("Enter")
      await expect
        .poll(() => page.getByText("Pinned again.").isVisible(), { timeout: 30_000 })
        .toBe(true)
      await expect.poll(async () => Math.round(await fromEnd())).toBe(0)
      expect(await inView(".msg-user")).toBe(true)
      // A tool group near the end opened: its head stays under the pointer, the steps open below
      // it (closing it there moves it down: nothing below to scroll into, as in any log).
      const group = page.locator(".tool-group-head").last()
      await group.click()
      await frames()
      const at = (await group.boundingBox())?.y ?? -1
      await group.click()
      await frames()
      expect(Math.abs(((await group.boundingBox())?.y ?? -1) - at)).toBeLessThanOrEqual(1)
      // Scrolled up, a group in view opened and closed: its head stays (the browser's anchoring and
      // the log's own correction never both move it).
      const visible = await log.evaluate((l) => {
        const heads = [...l.querySelectorAll(".tool-group-head")]
        const index = heads.length - 2
        const h = heads[index]
        if (h === undefined) return -1
        // That group a third of the way down the log: scrolled up, away from the end.
        const box = l.getBoundingClientRect()
        l.scrollTop += h.getBoundingClientRect().top - (box.top + box.height / 3)
        return index
      })
      expect(visible).toBeGreaterThanOrEqual(0)
      await frames()
      expect(await fromEnd()).toBeGreaterThan(40)
      const head = page.locator(".tool-group-head").nth(visible)
      for (let i = 0; i < 2; i++) {
        const y = (await head.boundingBox())?.y ?? -1
        await head.click()
        await frames()
        expect(Math.abs(((await head.boundingBox())?.y ?? -1) - y)).toBeLessThanOrEqual(1)
      }
    } finally {
      await app.evaluate(({ BrowserWindow }, size) => {
        const [width = 0, height = 0] = size ?? []
        BrowserWindow.getAllWindows()[0]?.setSize(width, height)
      }, window0)
    }
    expect(
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getSize()),
    ).toEqual(window0)
  })

  it("closes the agent's browser with the project, and launches it again for the next", async () => {
    const pid = app.process().pid
    // The agent's browser: its main process, anywhere under the app's.
    const browsers = async () =>
      treeOf(await processes(), pid ?? -1).filter((p) => role(p, pid ?? -1) === "agent-browser")
        .length
    expect(await browsers()).toBe(1)
    await page.getByRole("button", { name: /Fixture app/ }).click()
    await page.getByRole("menuitem", { name: "Close project" }).click()
    await expect
      .poll(() => page.getByRole("heading", { name: "Start a demo" }).isVisible())
      .toBe(true)
    await expect.poll(browsers).toBe(0)
    // The same project again (the picker still answers with it): its agent works, in a new browser.
    await page.getByRole("button", { name: "Open a project…" }).click()
    await expect
      .poll(() => page.getByRole("button", { name: /Fixture app/ }).isVisible())
      .toBe(true)
    const box = page.getByLabel("Message the agent")
    await box.fill("Go home")
    await box.press("Enter")
    await expect
      .poll(() => page.getByText("Back home.").isVisible(), { timeout: 30_000 })
      .toBe(true)
    expect(await page.getByText(/didn.t start/).count()).toBe(0)
    expect(await browsers()).toBe(1)
  })

  it("is served from the app's own origin, sandboxed, with a strict CSP", async () => {
    expect(page.url()).toBe("kiframe-app://app/index.html")
    const reach = await page.evaluate(() => ({
      node: typeof (globalThis as { require?: unknown }).require,
      process: typeof (globalThis as { process?: unknown }).process,
      api: Object.keys((globalThis as unknown as { kiframe: object }).kiframe).sort(),
    }))
    expect(reach).toEqual({
      node: "undefined",
      process: "undefined",
      api: ["invoke", "on", "platform"],
    })
    // An inline script is refused by the CSP.
    const inline = await page.evaluate(() => {
      const s = document.createElement("script")
      s.textContent = "window.__inline = 1"
      document.head.append(s)
      return (window as { __inline?: number }).__inline ?? null
    })
    expect(inline).toBeNull()
  })

  it("asks before removing the key, and keeps it when the user cancels", async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = () => Promise.resolve({ response: 1, checkboxChecked: false })
    })
    await page.getByRole("button", { name: /Fixture app/ }).click()
    await page.getByRole("menuitem", { name: "Change OpenRouter key…" }).click()
    await expect.poll(() => page.getByRole("region", { name: "Scenes" }).isVisible()).toBe(true)
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = () => Promise.resolve({ response: 0, checkboxChecked: false })
    })
    await page.getByRole("button", { name: /Fixture app/ }).click()
    await page.getByRole("menuitem", { name: "Change OpenRouter key…" }).click()
    await expect
      .poll(() => page.getByRole("heading", { name: "Connect a model" }).isVisible())
      .toBe(true)
  })

  it("loads every font and asset under its CSP (nothing refused)", async () => {
    // From here: the CSP test above injected a refused inline script on purpose.
    consoleErrors.length = 0
    // Glyphs from the smaller subsets too (Vietnamese, Cyrillic): every face is loaded for them,
    // and none fails (a face the CSP refuses ends in "error").
    const faces = await page.evaluate(async () => {
      const text = "Tiếng Việt Ѐѐ abc"
      for (const family of ["JetBrains Mono", "Instrument Sans"]) {
        for (const weight of [400, 500, 600]) {
          await document.fonts.load(`${weight} 16px "${family}"`, text).catch(() => [])
        }
      }
      const all = [...document.fonts]
      return {
        loaded: all.filter((f) => f.status === "loaded").length,
        failed: all.filter((f) => f.status === "error").map((f) => `${f.family} ${f.weight}`),
      }
    })
    expect(faces.failed).toEqual([])
    expect(faces.loaded).toBeGreaterThan(6)
    expect(consoleErrors).toEqual([])
  })
  // Last: the blocked navigation leaves Playwright waiting for it (later clicks would wait too).
  it("never opens a window, navigates away or answers an unknown channel", async () => {
    await page.evaluate(() => window.open("https://example.com"))
    expect(app.windows()).toHaveLength(1)
    await page.evaluate(() => {
      location.href = "https://example.com"
    })
    await page.waitForTimeout(300)
    expect(page.url()).toBe("kiframe-app://app/index.html")
    const unknown = await page.evaluate(() =>
      (window as unknown as { kiframe: { invoke: (c: string) => Promise<unknown> } }).kiframe
        .invoke("fs:read")
        .then(
          () => "answered",
          (e: Error) => e.message,
        ),
    )
    expect(unknown).toMatch(/unknown channel/)
    const invalid = await page.evaluate(() =>
      (
        window as unknown as { kiframe: { invoke: (c: string, a: unknown) => Promise<unknown> } }
      ).kiframe
        .invoke("project:create", { name: "x", url: "https://app.test", dir: "/etc" })
        .then(
          () => "answered",
          (e: Error) => e.message,
        ),
    )
    expect(invalid).toMatch(/invalid project:create/)
    // A bad address is the project's rule, said as the status's error (no dialog opened).
    const refused = await page.evaluate(() =>
      (
        window as unknown as {
          kiframe: { invoke: (c: string, a: unknown) => Promise<{ error: string | null }> }
        }
      ).kiframe
        .invoke("project:create", { name: "x", url: "file:///etc/passwd" })
        .then((s) => s.error),
    )
    expect(refused).toMatch(/App address/)
  })
})
