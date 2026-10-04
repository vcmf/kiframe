// What the perf scripts share: the process table and an app's process tree by role, and the built
// desktop app launched with a scripted model on a throwaway profile, a project open.
import { execFile } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { createProject } from "@kiframe/project"
import { _electron as electron, type ElectronApplication, type Page } from "playwright"

export const root = join(import.meta.dirname, "..", "..")
export const appDir = join(root, "apps", "desktop")
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface Proc {
  pid: number
  ppid: number
  rssKb: number
  cpu: number
  command: string
}

const run = promisify(execFile)

/** Every process on the machine (read without blocking the script: its timings stay its own). */
export async function processes(): Promise<Proc[]> {
  const { stdout } = await run("ps", ["-axo", "pid=,ppid=,rss=,pcpu=,command="], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
  return stdout
    .split("\n")
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ pid: +m[1]!, ppid: +m[2]!, rssKb: +m[3]!, cpu: +m[4]!, command: m[5]! }))
}

/** A process and everything under it. */
export function treeOf(all: Proc[], rootPid: number): Proc[] {
  const kids = new Map<number, Proc[]>()
  for (const p of all) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p])
  const list = all.filter((p) => p.pid === rootPid)
  const walk = (pid: number) => {
    for (const k of kids.get(pid) ?? []) {
      list.push(k)
      walk(k.pid)
    }
  }
  walk(rootPid)
  return list
}

/** What a process of the app is: its main process, its helpers, the agent's browser, ffmpeg. */
export function role(p: Proc, mainPid: number): string {
  const c = p.command
  if (p.pid === mainPid) return "app-main"
  if (/ffmpeg/.test(c)) return "ffmpeg"
  if (/ms-playwright|chrome-headless-shell|Chromium/i.test(c)) {
    if (/--type=renderer/.test(c)) return "agent-tab"
    if (/--type=gpu/.test(c)) return "agent-gpu"
    if (/--type=/.test(c)) return "agent-other"
    return "agent-browser"
  }
  if (/--type=renderer/.test(c)) return "app-renderer"
  if (/--type=gpu/.test(c)) return "app-gpu"
  if (/--type=utility/.test(c)) return "app-utility"
  if (/--type=/.test(c)) return "app-other"
  return "other"
}

export interface RoleTotals {
  count: number
  rss: number
  cpu: number
}

/** The app's processes now, by role (each seen noted, for what's left after quitting). */
export async function sampleTree(
  mainPid: number,
  seen: Map<number, string>,
): Promise<{ procs: Proc[]; byRole: Map<string, RoleTotals> }> {
  const procs = treeOf(await processes(), mainPid)
  const byRole = new Map<string, RoleTotals>()
  for (const p of procs) {
    const r = role(p, mainPid)
    seen.set(p.pid, `${r} ${p.command.slice(0, 120)}`)
    const t = byRole.get(r) ?? { count: 0, rss: 0, cpu: 0 }
    byRole.set(r, { count: t.count + 1, rss: t.rss + p.rssKb / 1024, cpu: t.cpu + p.cpu })
  }
  return { procs, byRole }
}

/** A local site: each path's page (undefined: 404). */
export async function serve(
  page: (path: string) => string | undefined,
): Promise<{ url: string; close: () => void }> {
  const server = createServer((req, res) => {
    const body = page(req.url ?? "/")
    res.writeHead(body === undefined ? 404 : 200, { "content-type": "text/html" })
    res.end(body ?? "not found")
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const port = (server.address() as { port: number }).port
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() }
}

/** The temp folders a script made (profiles, projects): removed by `removeTemp`. */
const temps: string[] = []
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}
/** Removes every temp folder the script made (the app quit first: its takes are in its profile). */
export function removeTemp(): void {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
}
// However the script ends (a launch or a step that throws too): its temp folders go.
process.on("exit", removeTemp)

/**
 * Runs `work` every `ms`, one at a time (a tick while the last still runs is skipped), its failure
 * noted in `failed` (never an unhandled rejection that ends the script). Stops when called back.
 */
export function every(ms: number, work: () => Promise<unknown>, failed: string[]): () => void {
  let busy = false
  const timer = setInterval(() => {
    if (busy) return
    busy = true
    work()
      .catch((e: unknown) => failed.push(`sample: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => {
        busy = false
      })
  }, ms)
  return () => clearInterval(timer)
}

/** A scripted model turn calling one tool. */
export const call = (id: string, name: string, args: object) => ({
  kind: "tool_calls",
  calls: [{ id, name, arguments: JSON.stringify(args) }],
})

export interface Launched {
  app: ElectronApplication
  page: Page
  mainPid: number
  profile: string
}

/**
 * The built app on a throwaway profile, its model scripted with `turns`, its key in memory, and
 * the projects created (opened with `open`). `jsFlags`: e.g. `--expose-gc`.
 */
export async function launchScripted(options: {
  turns: object[]
  jsFlags?: string
}): Promise<Launched> {
  const profile = tempDir("kiframe-perf-")
  writeFileSync(join(profile, "model.json"), JSON.stringify(options.turns))
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (e): e is [string, string] =>
        e[1] !== undefined && e[0] !== "ELECTRON_RENDERER_URL" && e[0] !== "ELECTRON_RUN_AS_NODE",
    ),
  )
  env.KIFRAME_TEST_KEYCHAIN = "memory"
  env.KIFRAME_TEST_MODEL = join(profile, "model.json")
  const args = [appDir, `--user-data-dir=${profile}`]
  if (options.jsFlags !== undefined) args.unshift(`--js-flags=${options.jsFlags}`)
  const app = await electron.launch({ args, cwd: appDir, env })
  const mainPid = app.process().pid
  if (mainPid === undefined) throw new Error("no app pid")
  const page = await app.firstWindow()
  await page.getByLabel("OpenRouter API key").fill("sk-or-test-not-a-real-key")
  await page.getByRole("button", { name: "Save key" }).click()
  await page.getByRole("heading", { name: "Start a demo" }).waitFor()
  return { app, page, mainPid, profile }
}

/** A new project folder for the app at `url`. */
export function newProject(id: string, name: string, url: string): string {
  const dir = join(tempDir("kiframe-perf-project-"), `${id}.kiframe`)
  createProject(dir, { id, name, url })
  return dir
}

/**
 * Opens a project in the app (the folder picker answers with it): from the start screen, or from
 * the open project `from`'s menu.
 */
export async function openProject(
  l: Launched,
  dir: string,
  name: string,
  from?: string,
): Promise<void> {
  await l.app.evaluate(({ dialog }, picked) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [picked] })
  }, dir)
  if (from === undefined) await l.page.getByRole("button", { name: "Open a project…" }).click()
  else {
    await l.page.getByRole("button", { name: new RegExp(from) }).click()
    await l.page.getByRole("menuitem", { name: "Open another project…" }).click()
  }
  await l.page.getByRole("button", { name: new RegExp(name) }).waitFor({ timeout: 30_000 })
}

/** Sends the agent a message. */
export async function send(page: Page, text: string): Promise<void> {
  const box = page.getByLabel("Message the agent")
  await box.fill(text)
  await box.press("Enter")
}

/** Quits as Cmd-Q does, then waits (at most `ms`) for the main process to end. */
export async function quit(l: Launched, ms = 30_000): Promise<number> {
  const at = Date.now()
  await l.app
    .evaluate(({ app }) => {
      setTimeout(() => app.quit(), 0)
    })
    .catch(() => undefined)
  while ((await processes()).some((p) => p.pid === l.mainPid)) {
    if (Date.now() - at > ms) throw new Error(`the app didn't quit in ${ms} ms`)
    await sleep(50)
  }
  return Date.now() - at
}

/** The app's processes still alive among those seen. */
export async function stillAlive(seen: Map<number, string>): Promise<string[]> {
  const alive = new Set((await processes()).map((p) => p.pid))
  return [...seen].filter(([pid]) => alive.has(pid)).map(([pid, what]) => `${pid} ${what}`)
}

/** Percentiles of a list (empty: zeros). */
export function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b)
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0
  return {
    n: s.length,
    p50: +q(0.5).toFixed(1),
    p95: +q(0.95).toFixed(1),
    max: +(s.at(-1) ?? 0).toFixed(1),
  }
}
