// Drives the built desktop app on a real test app with the real model, as a user would (APPROACHES
// §0 "Test apps"): the OpenRouter key entered, a project created for the app, its secrets added in
// the Secrets panel, the brief sent, and every request answered (risky steps and secrets allowed,
// questions answered with a fixed reply). Writes a report: the chat, the outcome, time and cost.
//
// Usage: node scripts/real-apps/drive.ts --app minmux|calcom|excalidraw [--minutes 20] [--brief "…"]
//    or: node scripts/real-apps/drive.ts --url https://… --brief "…" [--minutes 20]
// Add --export demo.mp4 to export the recorded scene (the take as the app reads it, then the exporter).
// Build the app first (pnpm --filter @kiframe/desktop build). Keys and secrets come from the root
// `.env` (never printed). Risky steps are approved: throwaway accounts only.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { TakeStore } from "@kiframe/project"
import { _electron as electron } from "playwright"
import { loadDotEnv } from "../lib/secrets.ts"

interface AppRun {
  name: string
  url: string
  /** Secrets added in the panel: name, kind, the environment variable holding the value. */
  secrets: { name: string; kind: "username" | "password"; env: string }[]
  brief: string
}

const APPS: Record<string, AppRun> = {
  minmux: {
    name: "minmux site",
    url: "https://minmux.dev",
    secrets: [],
    brief:
      "Make a short demo scene of the minmux website: start on the home page, show what minmux is " +
      "(scroll to its features), then open its docs or download page. Ground every step, save the " +
      "scene, then record it.",
  },
  calcom: {
    name: "Cal.com",
    url: "https://app.cal.com",
    secrets: [
      { name: "calcom.username", kind: "username", env: "CALCOM_USERNAME" },
      { name: "calcom.password", kind: "password", env: "CALCOM_PASSWORD" },
    ],
    brief:
      "Make a short demo scene of Cal.com: sign in with the secrets calcom.username and " +
      "calcom.password (in the setup), then open Event Types and open one event type to show its " +
      "settings. Don't create, change or delete anything. Ground every step, save the scene, then " +
      "record it.",
  },
  excalidraw: {
    name: "Excalidraw",
    url: "https://excalidraw.com",
    secrets: [],
    brief:
      "Make a short demo scene of Excalidraw: pick the rectangle tool, draw a rectangle on the " +
      "canvas, then add a text label inside it that says Hello. Ground every step, save the scene, " +
      "then record it.",
  },
}

const { values } = parseArgs({
  options: {
    app: { type: "string" },
    minutes: { type: "string", default: "20" },
    // Another request to send than the app's own (a user's, to reproduce what they saw).
    brief: { type: "string" },
    // Any other app: its address (with --brief), named after its host.
    url: { type: "string" },
    // The recorded scene exported to a video file (.mp4 or .webm), through the exporter.
    export: { type: "string" },
  },
})
function usage(why: string): never {
  console.error(
    `${why}\nusage: --app ${Object.keys(APPS).join("|")} [--minutes 20] [--brief "…"], or --url <address> --brief "…"`,
  )
  process.exit(2)
}
// Any other app: its address and the request to send, both; never with --app (which one would run).
let custom: AppRun | undefined
if (values.url !== undefined) {
  if (values.app !== undefined) usage("--url and --app: give one")
  if (values.brief === undefined) usage("--url needs --brief (what to ask the agent)")
  let address: URL
  try {
    address = new URL(values.url)
  } catch {
    usage(`--url ${values.url}: not an address (https://…)`)
  }
  custom = { name: address.hostname, url: values.url, secrets: [], brief: values.brief }
}
const run = custom ?? APPS[values.app ?? ""] ?? usage(`no app "${values.app ?? ""}"`)
// Names the run's folder: the host without its port (a ':' isn't allowed in a file name everywhere).
const label = custom !== undefined ? custom.name : (values.app ?? "")
// The app's environment: this process's own, before the `.env` is read (none of its values reach
// the app: the key and the secrets go through the app's UI, as a user gives them).
const inherited = { ...process.env }
loadDotEnv()
const key = process.env.OPENROUTER_API_KEY
if (key === undefined || key === "") throw new Error("OPENROUTER_API_KEY isn't set (root .env)")

const root = join(import.meta.dirname, "..", "..")
const out = join(root, ".kiframe-local", "real-apps", `${label}-${Date.now()}`)
mkdirSync(out, { recursive: true })
const log = (line: string) => console.log(`[${label}] ${line}`)

/**
 * The recorded scene to a video file: its take, as the app's preview reads it (decrypted, while the
 * app runs: its key is in memory), written as a plain take next to the report, then the exporter.
 */
async function exportVideo(status: unknown, file: string): Promise<void> {
  const scenes = (status as { project?: { scenes?: { id: string; status: string }[] } }).project
    ?.scenes
  const scene = scenes?.find((s) => s.status === "recorded")
  if (scene === undefined) return log("no export: nothing recorded")
  const preview = await page.evaluate(async (id) => {
    const api = (
      window as unknown as { kiframe: { invoke: (c: string, a: string) => Promise<unknown> } }
    ).kiframe
    const r = (await api.invoke("preview:open", id)) as
      | { ok: false; why: string }
      | {
          ok: true
          video: Uint8Array
          take: unknown
          composition: object
          scenario: unknown
          style: object
        }
    if (!r.ok) return { why: r.why }
    let bin = ""
    for (let i = 0; i < r.video.length; i += 0x8000) {
      bin += String.fromCharCode(...r.video.subarray(i, i + 0x8000))
    }
    return {
      video: btoa(bin),
      take: r.take,
      composition: r.composition,
      scenario: r.scenario,
      style: r.style,
    }
  }, scene.id)
  if ("why" in preview) return log(`no export: ${preview.why}`)
  const take = preview.take as { meta: unknown; events: unknown[]; cursor: unknown[] }
  const dir = join(out, "export")
  const takeDir = join(dir, "take")
  mkdirSync(takeDir, { recursive: true })
  writeFileSync(join(takeDir, "meta.json"), JSON.stringify(take.meta))
  writeFileSync(
    join(takeDir, "events.jsonl"),
    take.events.map((e) => JSON.stringify(e)).join("\n") + "\n",
  )
  writeFileSync(
    join(takeDir, "cursor.jsonl"),
    take.cursor.map((c) => JSON.stringify(c)).join("\n") + "\n",
  )
  writeFileSync(join(takeDir, "frames.webm"), Buffer.from(preview.video, "base64"))
  // JSON is YAML: the scenario as the app has it; a project file only to be read (the composition
  // is given: nothing generated from it).
  writeFileSync(join(dir, "scenario.yaml"), JSON.stringify(preview.scenario))
  // The style as the preview resolved it (the project's and the scene's): the exporter reads no
  // project style.
  writeFileSync(
    join(dir, "composition.json"),
    JSON.stringify({ ...preview.composition, style: preview.style }),
  )
  writeFileSync(
    join(dir, "project.yaml"),
    `version: 1\ntarget: { kind: web, url: "${run.url}", viewport: { width: 1440, height: 900 } }\n`,
  )
  const { spawnSync } = await import("node:child_process")
  const done = spawnSync(
    process.execPath,
    [
      join(root, "apps", "exporter", "src", "cli.ts"),
      "--project",
      join(dir, "project.yaml"),
      "--scenario",
      join(dir, "scenario.yaml"),
      "--composition",
      join(dir, "composition.json"),
      "--take",
      takeDir,
      "--out",
      resolve(file),
    ],
    { stdio: "inherit" },
  )
  log(done.status === 0 ? `exported: ${resolve(file)}` : `export failed (${done.status ?? "?"})`)
}

/** The complete takes the app's take store holds (its own reading: leftovers and bad ones skipped). */
function completeTakes(data: string): number {
  const store = new TakeStore(data)
  const dir = join(data, "takes")
  if (!existsSync(dir)) return 0
  const subdirs = (d: string) =>
    readdirSync(d, { withFileTypes: true }).filter(
      (e) => e.isDirectory() && !e.name.startsWith("."),
    )
  return subdirs(dir).reduce(
    (n, project) =>
      n +
      subdirs(join(dir, project.name)).reduce(
        (m, scene) => m + store.takes(project.name, scene.name).length,
        0,
      ),
    0,
  )
}

async function credits(): Promise<number | undefined> {
  const res = await fetch("https://openrouter.ai/api/v1/key", {
    headers: { authorization: `Bearer ${key}` },
  }).catch(() => undefined)
  if (res?.ok !== true) return undefined
  const body = (await res.json()) as { data?: { usage?: number } }
  return body.data?.usage
}

const env = Object.fromEntries(
  Object.entries(inherited).filter(
    (e): e is [string, string] =>
      e[1] !== undefined && e[0] !== "ELECTRON_RENDERER_URL" && e[0] !== "ELECTRON_RUN_AS_NODE",
  ),
)
env.KIFRAME_TEST_KEYCHAIN = "memory"
const profile = mkdtempSync(join(tmpdir(), "kiframe-real-"))
const usageBefore = await credits()
const started = Date.now()
const app = await electron.launch({
  args: [join(root, "apps", "desktop"), `--user-data-dir=${profile}`],
  cwd: join(root, "apps", "desktop"),
  env,
})
const page = await app.firstWindow()
await page.setViewportSize({ width: 1440, height: 900 }).catch(() => undefined)
const shot = (name: string) =>
  page.screenshot({ path: join(out, `${name}.png`) }).catch(() => undefined)

try {
  // The key, then the project (main's save dialog answered with a folder in the run's output).
  await page.getByLabel("OpenRouter API key").fill(key)
  await page.getByRole("button", { name: "Save key" }).click()
  const dir = join(out, "project.kiframe")
  await app.evaluate(({ dialog }, picked) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: picked })
  }, dir)
  await page.getByLabel("Project name").fill(run.name)
  await page.getByLabel("App address").fill(run.url)
  await page.getByRole("button", { name: "Create project…" }).click()
  await page.getByRole("region", { name: "Scenes" }).waitFor({ timeout: 30_000 })
  log("project created")

  for (const secret of run.secrets) {
    const value = process.env[secret.env]
    if (value === undefined || value === "") throw new Error(`${secret.env} isn't set (root .env)`)
    await page.getByRole("button", { name: "Secrets" }).click()
    const panel = page.getByRole("dialog", { name: "Secrets" })
    await panel.getByRole("textbox", { name: "Name", exact: true }).fill(secret.name)
    await panel.getByLabel("Kind", { exact: true }).selectOption(secret.kind)
    await panel.getByLabel("Value", { exact: true }).fill(value)
    await panel.getByRole("button", { name: "Add secret" }).click()
    await panel.getByText(secret.name, { exact: true }).waitFor({ timeout: 15_000 })
    await panel.getByRole("button", { name: "Close" }).click()
    log(`secret ${secret.name} added`)
  }

  const send = async (text: string) => {
    const box = page.getByLabel("Message the agent")
    await box.fill(text)
    await box.press("Enter")
    await page.getByRole("button", { name: "Stop" }).waitFor({ timeout: 30_000 })
  }
  await send(values.brief ?? run.brief)
  log("brief sent")

  const deadline = started + Number(values.minutes) * 60_000
  let nudged = false
  for (;;) {
    if (Date.now() > deadline) {
      log("time's up: stopping")
      await page
        .getByRole("button", { name: "Stop" })
        .click()
        .catch(() => undefined)
      break
    }
    // Answer whatever the agent asks (as the user would on a throwaway account).
    const allow = page.getByRole("button", { name: "Allow here" })
    const approve = page.getByRole("button", { name: "Approve this step" })
    const reply = page.getByLabel("Your answer")
    if (await allow.isVisible().catch(() => false)) {
      // Never a screenshot here: the approval shows the page unmasked (APPROACHES: never to a file).
      await allow.click()
      log("secret use allowed")
    } else if (
      await approve
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      await approve.first().click()
      log("risky step approved")
    } else if (
      await reply
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      await reply.first().fill("Use your best judgment; keep the scene short.")
      await page.getByRole("button", { name: "Answer" }).first().click()
      log("question answered")
    }
    const running = await page
      .getByRole("button", { name: "Stop" })
      .isVisible()
      .catch(() => false)
    if (!running) {
      const state = await page.evaluate(() =>
        (
          window as unknown as {
            kiframe: {
              invoke: (
                c: string,
              ) => Promise<{ items: { kind: string; name?: string; status?: string }[] }>
            }
          }
        ).kiframe.invoke("chat:state"),
      )
      const recorded = state.items.some(
        (i) => i.kind === "tool" && i.name === "record_scene" && i.status === "ok",
      )
      if (recorded || nudged) break
      // Once: the agent stopped before filming: asked to finish.
      nudged = true
      log("the run ended without a recording: asking to save and record")
      await send("Please finish: fix what failed if anything, save the scene, then record it.")
    }
    await page.waitForTimeout(1000)
  }

  await shot("end")
  // The preview of what was filmed (S4): played a moment, then shown.
  const play = page.getByRole("button", { name: "Play" })
  const previewed = await play
    .waitFor({ timeout: 30_000 })
    .then(() => true)
    .catch(() => false)
  if (previewed) {
    await play.click()
    await page.waitForTimeout(2500)
    await shot("preview")
    log("preview played")
  } else {
    log(
      `no preview: ${
        (await page
          .locator(".player-note")
          .textContent()
          .catch(() => null)) ?? "none"
      }`,
    )
  }
  const state = await page.evaluate(() =>
    (window as unknown as { kiframe: { invoke: (c: string) => Promise<unknown> } }).kiframe.invoke(
      "chat:state",
    ),
  )
  const status = await page.evaluate(() =>
    (window as unknown as { kiframe: { invoke: (c: string) => Promise<unknown> } }).kiframe.invoke(
      "app:status",
    ),
  )
  if (values.export !== undefined && previewed) await exportVideo(status, values.export)
  const usageAfter = await credits()
  const report = {
    app: label,
    url: run.url,
    minutes: Math.round((Date.now() - started) / 600) / 100,
    costUsd:
      usageBefore !== undefined && usageAfter !== undefined
        ? Math.round((usageAfter - usageBefore) * 10000) / 10000
        : null,
    // Complete takes only (a take folder exists once a recording starts).
    takes: completeTakes(join(profile, "data")),
    status,
    chat: state,
  }
  writeFileSync(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`)
  log(
    `done in ${report.minutes} min, cost ${report.costUsd ?? "?"} USD: ${join(out, "report.json")}`,
  )
} catch (error) {
  await shot("error")
  log(`failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  await app.close().catch(() => undefined)
}
