import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { generate } from "@kiframe/generators"
import { recordScenario } from "@kiframe/runtime"
import { parseProjectYaml, parseScenarioYaml } from "@kiframe/schema"
import { build } from "esbuild"
import { chromium } from "playwright"
import { describe, expect, it } from "vitest"
import { startFixtureServer } from "../../runtime/test/fixture-server.ts"
import { prepare } from "../src/scene.ts"

// The preview player in a real browser, on a real take: what it shows at a time is what the export
// draws there (the same pieces), and it plays at the wall clock, pauses, and ends.
describe("the preview player", { timeout: 180_000 }, () => {
  it("seeks, plays, pauses and ends on a recorded take", async () => {
    const server = await startFixtureServer()
    const browser = await chromium.launch()
    try {
      const project = parseProjectYaml(`version: 2
apps: { app: { kind: web, url: "${server.url}", viewport: { width: 1280, height: 800 } } }
defaults: { pacing: { settleMs: 0, cursor: fast, typing: fast } }
`)
      const scenario = parseScenarioYaml(`version: 1
setup: [{ action: goto, url: /projects }]
steps:
  - { id: open-new, action: click, target: { by: role, role: button, name: New project }, caption: "Create a project" }
  - { id: name, action: type, target: { by: label, name: Project name }, value: "Q4 Launch" }
  - { id: beat, action: pause, ms: 4000 }
`)
      const dir = join(mkdtempSync(join(tmpdir(), "kiframe-player-")), "take")
      const recordPage = await browser.newPage({ viewport: { width: 1280, height: 800 } })
      const take = await recordScenario(recordPage, scenario, project, {
        outDir: dir,
        scope: "test",
        sceneId: "test",
      })
      await recordPage.close()
      const { composition } = generate(project, scenario, take)

      const bundled = await build({
        entryPoints: [fileURLToPath(new URL("./player-page.ts", import.meta.url))],
        bundle: true,
        format: "esm",
        platform: "browser",
        target: "chrome120",
        write: false,
        logLevel: "silent",
      })
      const script = bundled.outputFiles[0]?.text ?? ""
      const page = await browser.newPage()
      // localhost is a secure context: WebCodecs exists only there.
      const origin = "http://localhost"
      await page.route(`${origin}/**`, (route) => {
        const path = new URL(route.request().url()).pathname
        if (path === "/frames.webm") {
          return route.fulfill({
            body: readFileSync(join(dir, "frames.webm")),
            contentType: "video/webm",
          })
        }
        if (path === "/player.js")
          return route.fulfill({ body: script, contentType: "text/javascript" })
        return route.fulfill({
          body: '<!doctype html><body><script type="module" src="/player.js"></script></body>',
          contentType: "text/html",
        })
      })
      await page.goto(`${origin}/`)
      await page.waitForFunction(() => typeof window.playerTest === "object")
      const style = { width: 960, height: 540, fps: 30 }
      const duration = await page.evaluate((args) => window.playerTest.load(args), {
        videoUrl: `${origin}/frames.webm`,
        composition,
        scenario,
        take: { meta: take.meta, events: take.events, cursor: take.cursor },
        style,
      })
      // As long as the export makes it (the same composition, the same time map).
      expect(duration).toBe(prepare(composition, scenario, take, style).duration)

      // Seeking shows that time's frame (the caption, the cursor elsewhere): never the same picture.
      const first = await page.evaluate(() => window.playerTest.seek(0))
      const middle = await page.evaluate((t) => window.playerTest.seek(t), duration / 2)
      expect(middle).not.toBe(first)
      expect(await page.evaluate((t) => window.playerTest.seek(t), duration / 2)).toBe(middle)

      // Plays at the wall clock, from where it is.
      await page.evaluate(() => window.playerTest.seek(0))
      await page.evaluate(() => window.playerTest.play())
      await page.waitForTimeout(600)
      const playing = await page.evaluate(() => window.playerTest.state())
      expect(playing.playing).toBe(true)
      expect(playing.time).toBeGreaterThan(300)
      expect(playing.time).toBeLessThan(1200)
      // Paused: time stands still.
      await page.evaluate(() => window.playerTest.pause())
      const paused = await page.evaluate(() => window.playerTest.state())
      await page.waitForTimeout(300)
      expect(await page.evaluate(() => window.playerTest.state().time)).toBe(paused.time)
      // Play right after a seek (its frame still decoding) starts where the seek asked.
      const half = duration / 2
      await page.evaluate((t) => {
        void window.playerTest.seek(t)
        window.playerTest.play()
      }, half)
      await page.waitForTimeout(200)
      const after = await page.evaluate(() => window.playerTest.state())
      await page.evaluate(() => window.playerTest.pause())
      expect(after.time).toBeGreaterThan(half)
      // A machine too slow to decode every frame in time (the CPU throttled 12x).
      const cdp = await page.context().newCDPSession(page)
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 12 })
      await page.evaluate(() => window.playerTest.seek(0))
      const began = Date.now()
      await page.evaluate(() => window.playerTest.play())
      const pictures = new Set<string>()
      for (let i = 0; i < 6; i++) {
        await page.waitForTimeout(200)
        pictures.add((await page.evaluate(() => window.playerTest.state())).pixels)
      }
      const slow = await page.evaluate(() => window.playerTest.state())
      const elapsed = Date.now() - began
      await page.evaluate(() => window.playerTest.pause())
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 })
      // It moves on (the picture changes, the time advances: never frozen at the start, as a
      // player that skipped every late frame was), and never ahead of the clock. (Behind it on a
      // machine this slow: every frame between two keyframes is decoded whatever is shown.)
      expect(slow.time).toBeGreaterThan(500)
      expect(slow.time).toBeLessThanOrEqual(elapsed + 100)
      expect(pictures.size).toBeGreaterThan(2)
      // Played to the end: stopped there.
      await page.evaluate((t) => window.playerTest.seek(t), duration - 300)
      await page.evaluate(() => window.playerTest.play())
      await page.waitForFunction(() => !window.playerTest.state().playing, undefined, {
        timeout: 5000,
      })
      expect(await page.evaluate(() => window.playerTest.state().time)).toBe(duration)
    } finally {
      await browser.close()
      await server.close()
    }
  })
})
