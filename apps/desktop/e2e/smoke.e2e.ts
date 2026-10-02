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

const appDir = join(import.meta.dirname, "..")
const shots = process.env.KIFRAME_E2E_SHOTS
let server: Awaited<ReturnType<typeof startFixtureServer>>
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
    await box.fill("Open the projects page")
    await box.press("Enter")
    const card = page.getByLabel("Approve a risky step?")
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
