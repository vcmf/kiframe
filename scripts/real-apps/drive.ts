// Drives the built desktop app on a real test app with the real model, as a user would (APPROACHES
// §0 "Test apps"): the OpenRouter key entered, a project created for the app, its secrets added in
// the Secrets panel, the brief sent, and every request answered (risky steps and secrets allowed,
// questions answered with a fixed reply). Writes a report: the chat, the outcome, time and cost.
//
// Usage: node scripts/real-apps/drive.ts --app minmux|calcom|excalidraw [--minutes 20]
// Build the app first (pnpm --filter @kiframe/desktop build). Keys and secrets come from the root
// `.env` (never printed). Risky steps are approved: throwaway accounts only.
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { _electron as electron, type Page } from "playwright"
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
  options: { app: { type: "string" }, minutes: { type: "string", default: "20" } },
})
const run = APPS[values.app ?? ""]
if (run === undefined) {
  console.error(`usage: --app ${Object.keys(APPS).join("|")} [--minutes 20]`)
  process.exit(2)
}
loadDotEnv()
const key = process.env.OPENROUTER_API_KEY
if (key === undefined || key === "") throw new Error("OPENROUTER_API_KEY isn't set (root .env)")

const root = join(import.meta.dirname, "..", "..")
const out = join(root, ".kiframe-local", "real-apps", `${values.app}-${Date.now()}`)
mkdirSync(out, { recursive: true })
const log = (line: string) => console.log(`[${values.app}] ${line}`)

async function credits(): Promise<number | undefined> {
  const res = await fetch("https://openrouter.ai/api/v1/key", {
    headers: { authorization: `Bearer ${key}` },
  }).catch(() => undefined)
  if (res?.ok !== true) return undefined
  const body = (await res.json()) as { data?: { usage?: number } }
  return body.data?.usage
}

const env = Object.fromEntries(
  Object.entries(process.env).filter(
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
  await send(run.brief)
  log("brief sent")

  const deadline = started + Number(values.minutes) * 60_000
  let nudged = false
  let answered = 0
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
      await shot(`secret-approval-${answered}`)
      await allow.click()
      log("secret use allowed")
      answered += 1
    } else if (
      await approve
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      await approve.first().click()
      log("risky step approved")
      answered += 1
    } else if (
      await reply
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      await reply.first().fill("Use your best judgment; keep the scene short.")
      await page.getByRole("button", { name: "Answer" }).first().click()
      log("question answered")
      answered += 1
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
  const usageAfter = await credits()
  const report = {
    app: values.app,
    url: run.url,
    minutes: Math.round((Date.now() - started) / 600) / 100,
    costUsd:
      usageBefore !== undefined && usageAfter !== undefined
        ? Math.round((usageAfter - usageBefore) * 10000) / 10000
        : null,
    takes: existsSync(join(profile, "data", "takes")),
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
