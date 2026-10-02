// The built app, launched as a user would get it (a throwaway profile, the key in memory): the
// first run asks for the key, then for a project; the window is hardened.
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createProject, saveScene } from "@kiframe/project"
import { parseScenarioYaml } from "@kiframe/schema"
import { _electron as electron, type ElectronApplication, type Page } from "playwright"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const appDir = join(import.meta.dirname, "..")
const shots = process.env.KIFRAME_E2E_SHOTS
let app: ElectronApplication
let page: Page

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
  app = await electron.launch({
    args: [appDir, `--user-data-dir=${profile}`],
    cwd: appDir,
    env,
  })
  page = await app.firstWindow()
})

afterAll(async () => {
  await app?.close()
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
        .invoke("project:create", { name: "x", url: "file:///etc/passwd" })
        .then(
          () => "answered",
          (e: Error) => e.message,
        ),
    )
    expect(invalid).toMatch(/invalid project:create/)
  })
})
