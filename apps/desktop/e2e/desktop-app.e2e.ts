// "Add desktop app…" end to end (macOS: Seatbelt, codesign): the built app adds a real bundle (the
// repo's Electron, the runtime's fixture as its app, re-signed ad hoc) picked through main's
// dialog (stubbed), inspected, tried confined, written to the project and approved. Its work area
// is a test's own (never ~/.kiframe).
import { execFileSync } from "node:child_process"
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createProject } from "@kiframe/project"
import { _electron as electron, type ElectronApplication, type Page } from "playwright"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const appDir = join(import.meta.dirname, "..")
const mac = process.platform === "darwin"
let app: ElectronApplication | undefined
let page: Page
let root: string
let bundle: string
let work: string

beforeAll(async () => {
  if (!mac) return
  root = mkdtempSync(join(tmpdir(), "kiframe-e2e-desktop-"))
  // A real bundle with no hook in it: Electron cloned, the fixture as its app, re-signed.
  const electronExe = createRequire(join(appDir, "package.json"))("electron") as string
  bundle = join(root, "Notes.app")
  execFileSync("cp", ["-cR", electronExe.slice(0, electronExe.indexOf(".app/") + 4), bundle])
  cpSync(
    join(appDir, "../../packages/runtime/test/fixtures/electron-app"),
    join(bundle, "Contents/Resources/app"),
    { recursive: true },
  )
  const plist = join(bundle, "Contents/Info.plist")
  execFileSync("plutil", [
    "-replace",
    "CFBundleIdentifier",
    "-string",
    "com.kiframe.e2e-notes",
    plist,
  ])
  for (const key of ["CFBundleName", "CFBundleDisplayName"]) {
    execFileSync("plutil", ["-replace", key, "-string", "Notes", plist])
  }
  execFileSync("codesign", ["-s", "-", "-f", "--deep", bundle], { stdio: "ignore" })
  work = join(root, "work")
  const profile = join(root, "profile")
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (e): e is [string, string] =>
        e[1] !== undefined && e[0] !== "ELECTRON_RENDERER_URL" && e[0] !== "ELECTRON_RUN_AS_NODE",
    ),
  )
  env.KIFRAME_TEST_KEYCHAIN = "memory"
  env.KIFRAME_WORK_DIR = work
  app = await electron.launch({ args: [appDir, `--user-data-dir=${profile}`], cwd: appDir, env })
  page = await app.firstWindow()
  await page.getByLabel("OpenRouter API key").fill("sk-or-test-not-a-real-key")
  await page.getByRole("button", { name: "Save key" }).click()
}, 120_000)

afterAll(async () => {
  await app?.close()
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
})

describe.runIf(mac)("adding a desktop app", () => {
  it("picks it, tries it confined, adds it to the project and approves it on this Mac", async () => {
    const dir = join(root, "demo.kiframe")
    createProject(dir, { id: "p1", name: "Desktop demo", url: "https://app.example" })
    await app!.evaluate(({ dialog }, picked) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [picked] })
    }, dir)
    await page.getByRole("button", { name: "Open a project…" }).click()
    await page.getByRole("button", { name: /app\.example/ }).click()
    const panel = page.getByRole("dialog", { name: "Apps" })
    // The app picker answers with the bundle (main's dialog, stubbed).
    await app!.evaluate(({ dialog }, picked) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [picked] })
    }, bundle)
    await panel.getByRole("button", { name: "Add desktop app…" }).click()
    const adding = panel.getByRole("region", { name: "Adding Notes" })
    await expect.poll(() => adding.textContent()).toMatch(/not signed by a developer: pinned/)
    await adding.getByRole("button", { name: "Check" }).click()
    await expect
      .poll(() => adding.getByRole("status").textContent(), { timeout: 40_000 })
      .toMatch(/runs confined/)
    await adding.getByRole("button", { name: "Add Notes" }).click()
    await expect
      .poll(() => panel.getByRole("list", { name: "The project's apps" }).textContent(), {
        timeout: 10_000,
      })
      .toMatch(/notes.*com\.kiframe\.e2e-notes.*Ready on this Mac/s)
    const written = JSON.parse(readFileSync(join(dir, "project.json"), "utf8")) as {
      apps: Record<string, unknown>
    }
    expect(written.apps["notes"]).toMatchObject({
      kind: "electron",
      bundleId: "com.kiframe.e2e-notes",
    })
    // The trial's sandbox gone; nothing of it in the user's own work area.
    expect(readdirSync(join(work, "sandboxes")).filter((n) => !n.endsWith(".canary"))).toEqual([])
  }, 120_000)
})
