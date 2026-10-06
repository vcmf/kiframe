import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { generate } from "@kiframe/generators"
import { createProject, saveScene, TakeStore } from "@kiframe/project"
import { recordScenario } from "@kiframe/runtime"
import { parseProjectYaml, parseScenarioYaml } from "@kiframe/schema"
import { chromium } from "playwright"
import { describe, expect, it } from "vitest"
import { startFixtureServer } from "../../../packages/runtime/test/fixture-server.ts"
import { previewOf } from "../src/main/preview.ts"

// A scene plays its own take only: the take its composition names, of the scenario as it is now.
describe("a scene's preview", { timeout: 120_000 }, () => {
  it("plays the take of the scene as it is, and says why when it can't", async () => {
    const server = await startFixtureServer()
    const browser = await chromium.launch()
    try {
      const opened = createProject(
        join(mkdtempSync(join(tmpdir(), "kiframe-prev-")), "p.kiframe"),
        {
          id: "p1",
          name: "Demo",
          url: server.url,
        },
      )
      const takes = new TakeStore(mkdtempSync(join(tmpdir(), "kiframe-data-")))
      const config = parseProjectYaml(`version: 2
apps: { app: { kind: web, url: "${server.url}", viewport: { width: 800, height: 600 } } }
defaults: { pacing: { settleMs: 0, cursor: instant, typing: instant } }
`)
      const scenario = parseScenarioYaml(`version: 1
setup: [{ action: goto, url: / }]
steps:
  - { id: open, action: click, target: { by: role, role: link, name: Projects }, caption: "Your projects" }
`)
      const scene = {
        version: 1 as const,
        id: "tour",
        title: "Tour",
        source: { kind: "recording" as const },
        duration: { mode: "auto" as const },
      }
      saveScene(opened, scene, { scenario })
      expect(await previewOf(opened, takes, "tour")).toEqual({
        ok: false,
        why: expect.stringMatching(/^Not filmed yet/) as unknown,
      })

      const dir = takes.newTakeDir("p1", "tour")
      const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
      const recorded = await recordScenario(page, scenario, config, {
        outDir: dir,
        scope: "test",
        sceneId: "tour",
      })
      const take = await takes.settle(dir)
      expect(take).toBeDefined()
      saveScene(opened, scene, { composition: generate(config, scenario, recorded).composition })

      const played = await previewOf(opened, takes, "tour")
      expect(played).toMatchObject({ ok: true, sceneId: "tour", title: "Tour" })
      if (!played.ok) throw new Error(played.why)
      expect(played.take.meta.takeKey).toBe(take?.meta.takeKey)
      expect(played.video.byteLength).toBeGreaterThan(1000)
      expect(played.take.events.length).toBeGreaterThan(0)

      // The scene changed since it was filmed (its composition kept by hand): never played as new.
      const changed = parseScenarioYaml(`version: 1
setup: [{ action: goto, url: / }]
steps:
  - { id: open, action: click, target: { by: role, role: link, name: Projects }, caption: "Projects" }
`)
      const stored = opened.scenes.get("tour")
      if (stored === undefined) throw new Error("no scene")
      opened.scenes.set("tour", { ...stored, scenario: changed })
      expect(await previewOf(opened, takes, "tour")).toEqual({
        ok: false,
        why: expect.stringMatching(/changed since it was filmed/) as unknown,
      })
      opened.scenes.set("tour", stored)

      // Its take gone from the store: said, never another take played instead.
      rmSync(dir, { recursive: true })
      expect(await previewOf(opened, takes, "tour")).toEqual({
        ok: false,
        why: expect.stringMatching(/take is gone/) as unknown,
      })
      expect(await previewOf(opened, takes, "nope")).toMatchObject({ ok: false })
    } finally {
      await browser.close()
      await server.close()
    }
  })
})
