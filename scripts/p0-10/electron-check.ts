// P0-10 (throwaway, report only): can we drive a packaged Electron app, and how?
//   A. Playwright `_electron.launch` (needs Node's --inspect: the EnableNodeCliInspectArguments fuse)
//   B. `--remote-debugging-port=0` + `chromium.connectOverCDP` (a Chromium switch, no fuse)
// Usage: node scripts/p0-10/electron-check.ts <path to the app's executable> [label]
// Each run uses its own temporary user-data dir: never the user's running instance or sessions.
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { _electron, chromium, type Browser, type ElectronApplication, type Page } from "playwright"

const exe = process.argv[2]
const label = process.argv[3] ?? exe
if (exe === undefined || !existsSync(exe)) {
  console.error(
    "usage: electron-check.ts <executable inside the app, e.g. X.app/Contents/MacOS/X> [label]",
  )
  process.exit(2)
}

const results: Record<string, unknown> = { app: label }
let path = "A"
// A failed `_electron.launch` can reject a second, internal promise: recorded under its path.
process.on("unhandledRejection", (error) => {
  results[`unhandled${path}`] = String(error).split("\n")[0]
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The app's visible main window (not DevTools, not a hidden or background page). */
async function mainWindow(pages: () => Page[]): Promise<Page | undefined> {
  for (let i = 0; i < 60; i++) {
    for (const page of pages()) {
      if (page.url().startsWith("devtools://")) continue
      const visible = await page.evaluate(() => document.visibilityState).catch(() => "")
      if (visible === "visible") return page
    }
    await sleep(250)
  }
  return pages()[0]
}

async function probe(page: Page) {
  await page.waitForLoadState("domcontentloaded")
  const title = await page.title()
  const visibility = await page.evaluate(() => document.visibilityState)
  const shot = await page
    .screenshot()
    .then((b) => b.length)
    .catch(() => 0)
  // Screencast frames for the same mouse moves (what the recorder needs), plus a forced repaint
  // each frame so both paths are measured on a page that changes.
  let frames = 0
  await page.evaluate(() => {
    const d = document.createElement("div")
    d.style.cssText = "position:fixed;left:0;top:0;width:4px;height:4px;z-index:2147483647"
    document.body.append(d)
    let n = 0
    const tick = () => {
      d.style.background = n++ % 2 ? "#000" : "#fff"
      requestAnimationFrame(tick)
    }
    tick()
  })
  await page.screencast.start({ size: { width: 1280, height: 800 }, onFrame: () => void frames++ })
  await page.mouse.move(200, 200)
  await page.mouse.move(400, 300, { steps: 10 })
  await sleep(1000)
  await page.screencast.stop()
  return { url: page.url(), title, visibility, screenshotBytes: shot, framesPerSecond: frames }
}

/** Waits for the child to exit (bounded), then removes its profile. */
async function stop(child: ChildProcess | undefined, dir: string) {
  if (child !== undefined && child.exitCode === null) {
    const exited = new Promise((r) => child.once("exit", r))
    child.kill()
    await Promise.race([exited, sleep(5000)])
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

// A. _electron.launch
{
  const dir = mkdtempSync(join(tmpdir(), "kiframe-p010-a-"))
  const started = Date.now()
  let app: ElectronApplication | undefined
  try {
    app = await _electron.launch({
      executablePath: exe,
      args: [`--user-data-dir=${dir}`],
      timeout: 20_000,
    })
    const page = await mainWindow(() => app?.windows() ?? [])
    if (page === undefined) throw new Error("launched, but no window")
    results.electronLaunch = { ok: true, ms: Date.now() - started, ...(await probe(page)) }
  } catch (error) {
    results.electronLaunch = {
      ok: false,
      ms: Date.now() - started,
      error: String(error).split("\n")[0],
    }
  } finally {
    await app?.close().catch(() => undefined)
    await stop(undefined, dir)
  }
}

// B. --remote-debugging-port=0 + connectOverCDP: Chromium picks a free port and writes it to
// DevToolsActivePort in the profile, so we can't attach to some other browser by mistake.
{
  path = "B"
  const dir = mkdtempSync(join(tmpdir(), "kiframe-p010-b-"))
  const started = Date.now()
  const child = spawn(exe, ["--remote-debugging-port=0", `--user-data-dir=${dir}`], {
    stdio: "ignore",
  })
  let spawnError: Error | undefined
  child.once("error", (error) => (spawnError = error))
  let browser: Browser | undefined
  try {
    const portFile = join(dir, "DevToolsActivePort")
    for (let i = 0; i < 60 && !existsSync(portFile); i++) {
      if (spawnError !== undefined) throw spawnError
      // An app that refuses the switch by quitting is told apart from a slow start.
      if (child.exitCode !== null)
        throw new Error(`the app exited (code ${child.exitCode}) before opening a debugging port`)
      await sleep(250)
    }
    if (!existsSync(portFile))
      throw new Error("no DevToolsActivePort after 15 s (the switch may be stripped)")
    const port = readFileSync(portFile, "utf8").split("\n")[0]
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    const context = browser.contexts()[0]
    const page = await mainWindow(() => context?.pages() ?? [])
    if (page === undefined) throw new Error("connected, but no window")
    results.connectOverCDP = { ok: true, ms: Date.now() - started, ...(await probe(page)) }
  } catch (error) {
    results.connectOverCDP = {
      ok: false,
      ms: Date.now() - started,
      error: String(error).split("\n")[0],
    }
  } finally {
    await browser?.close().catch(() => undefined)
    await stop(child, dir)
  }
}

console.log(JSON.stringify(results, null, 2))
