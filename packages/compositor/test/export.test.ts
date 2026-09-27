import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { generate } from "@kiframe/generators"
import { recordScenario } from "@kiframe/runtime"
import { parseProjectYaml, parseScenarioYaml } from "@kiframe/schema"
import { chromium } from "playwright"
import { describe, expect, it } from "vitest"
import { startFixtureServer } from "../../runtime/test/fixture-server.ts"
import { bundleExportPage } from "../browser/bundle.ts"
import { prepare } from "../src/scene.ts"

// End to end in a real browser: record a take, generate its composition, export it with WebCodecs.
// WebM/VP9 here: H.264 depends on the OS encoder (none in Chromium on Linux CI).
describe("export", { timeout: 180_000 }, () => {
  it("exports a take to a 1080p video whose length matches the composition", async () => {
    const server = await startFixtureServer()
    const browser = await chromium.launch()
    try {
      const project = parseProjectYaml(`version: 1
target: { kind: web, url: "${server.url}", viewport: { width: 1280, height: 800 } }
defaults: { pacing: { settleMs: 0, cursor: fast, typing: fast } }
`)
      const scenario = parseScenarioYaml(`version: 1
setup: [{ action: goto, url: /projects }]
steps:
  - { id: open-new, action: click, target: { by: role, role: button, name: New project }, caption: "Create a project" }
  - { id: name, action: type, target: { by: label, name: Project name }, value: "Q4 Launch" }
  - { id: pw, action: type, target: { by: label, name: Password }, value: "{{secrets.acme.password}}" }
`)
      const dir = join(mkdtempSync(join(tmpdir(), "kiframe-export-")), "take")
      const recordPage = await browser.newPage({ viewport: { width: 1280, height: 800 } })
      const take = await recordScenario(recordPage, scenario, project, {
        outDir: dir,
        resolveSecret: () => "hunter2",
      })
      await recordPage.close()
      const { composition } = generate(project, scenario, take)

      const script = await bundleExportPage()
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
        if (path === "/export.js")
          return route.fulfill({ body: script, contentType: "text/javascript" })
        return route.fulfill({
          body: '<!doctype html><script type="module" src="/export.js"></script>',
          contentType: "text/html",
        })
      })
      await page.goto(`${origin}/`)
      await page.waitForFunction(() => typeof window.kiframeExport === "function")
      const style = { width: 1920, height: 1080, fps: 30 }
      const result = await page.evaluate((args) => window.kiframeExport(args), {
        videoUrl: `${origin}/frames.webm`,
        composition,
        scenario,
        take: { meta: take.meta, events: take.events, cursor: take.cursor },
        format: "webm" as const,
        style,
      })
      const out = join(dir, "..", "export.webm")
      writeFileSync(out, Buffer.from(result.data, "base64"))

      const prepared = prepare(composition, scenario, take, style)
      const expected = prepared.duration
      const probe = JSON.parse(
        execFileSync(
          "ffprobe",
          [
            "-v",
            "error",
            "-show_entries",
            "format=duration:stream=width,height,codec_name",
            "-of",
            "json",
            out,
          ],
          { encoding: "utf8" },
        ),
      ) as {
        format: { duration: string }
        streams: { width: number; height: number; codec_name: string }[]
      }
      expect(probe.streams[0]).toMatchObject({ width: 1920, height: 1080, codec_name: "vp9" })
      expect(Math.abs(Number(probe.format.duration) * 1000 - expected)).toBeLessThan(100)
      expect(result.frames).toBe(Math.round((expected / 1000) * 30))
    } finally {
      await browser.close()
      await server.close()
    }
  })
})
