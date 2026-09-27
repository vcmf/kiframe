// P0-10 (throwaway, report only): can we drive a packaged Electron app, and how?
//   A. Playwright `_electron.launch` (needs Node's --inspect: the EnableNodeCliInspectArguments fuse)
//   B. `--remote-debugging-port` + `chromium.connectOverCDP` (a Chromium switch, no fuse)
// Usage: node scripts/p0-10/electron-check.ts <path to the app's executable> [label]
// Each run uses its own temporary user-data dir: never the user's running instance or sessions.
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { _electron, chromium } from "playwright"

const exe = process.argv[2]
const label = process.argv[3] ?? exe
if (exe === undefined) {
  console.error("usage: electron-check.ts <executable> [label]")
  process.exit(2)
}

async function probe(page: import("playwright").Page) {
  await page.waitForLoadState("domcontentloaded")
  const title = await page.title()
  const box = await page.locator("body").boundingBox()
  const shot = await page
    .screenshot()
    .then((b) => b.length)
    .catch(() => 0)
  // A screencast frame: what the recorder needs.
  let frames = 0
  await page.screencast.start({ size: { width: 1280, height: 800 }, onFrame: () => void frames++ })
  await page.mouse.move(200, 200)
  await page.mouse.move(400, 300, { steps: 10 })
  await new Promise((r) => setTimeout(r, 500))
  await page.screencast.stop()
  return { title, body: box !== null, screenshotBytes: shot, screencastFrames: frames }
}

const results: Record<string, unknown> = { app: label }
// A failed `_electron.launch` can reject a second, internal promise: record it, don't crash.
process.on("unhandledRejection", (error) => {
  results.unhandled = String(error).split("\n")[0]
})

// A. _electron.launch
{
  const dir = mkdtempSync(join(tmpdir(), "kiframe-p010-a-"))
  const started = Date.now()
  try {
    const app = await _electron.launch({
      executablePath: exe,
      args: [`--user-data-dir=${dir}`],
      timeout: 20_000,
    })
    const page = await app.firstWindow({ timeout: 15_000 })
    results.electronLaunch = { ok: true, ms: Date.now() - started, ...(await probe(page)) }
    await app.close()
  } catch (error) {
    results.electronLaunch = {
      ok: false,
      ms: Date.now() - started,
      error: String(error).split("\n")[0],
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// B. --remote-debugging-port + connectOverCDP
{
  const dir = mkdtempSync(join(tmpdir(), "kiframe-p010-b-"))
  const port = 9300 + Math.floor(Math.random() * 500)
  const started = Date.now()
  const child = spawn(exe, [`--remote-debugging-port=${port}`, `--user-data-dir=${dir}`], {
    stdio: "ignore",
  })
  try {
    let browser: import("playwright").Browser | undefined
    for (let i = 0; i < 60 && browser === undefined; i++) {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => undefined)
      if (browser === undefined) await new Promise((r) => setTimeout(r, 250))
    }
    if (browser === undefined) throw new Error(`no CDP endpoint on port ${port} after 15 s`)
    const context = browser.contexts()[0]
    let page = context?.pages()[0]
    for (let i = 0; i < 40 && page === undefined; i++) {
      await new Promise((r) => setTimeout(r, 250))
      page = context?.pages()[0]
    }
    if (page === undefined) throw new Error("connected, but no window")
    results.connectOverCDP = { ok: true, ms: Date.now() - started, ...(await probe(page)) }
    await browser.close()
  } catch (error) {
    results.connectOverCDP = {
      ok: false,
      ms: Date.now() - started,
      error: String(error).split("\n")[0],
    }
  } finally {
    child.kill()
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log(JSON.stringify(results, null, 2))
