import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { generate } from "@kiframe/generators"
import { recordScenario } from "../src/index.ts"
import { Composition, parseProjectYaml, parseScenarioYaml } from "@kiframe/schema"
import { chromium } from "playwright"
import { describe, expect, it } from "vitest"
import { startFixtureServer } from "./fixture-server.ts"

// End to end: a real take goes through the generators and gives a valid composition.
describe("record → generate", { timeout: 60_000 }, () => {
  it("generates camera, ripples and captions from a recorded take, its secret region in the take", async () => {
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
  - { id: pw, action: type, target: { by: label, name: Password }, value: "{{secrets.acme.password}}" }
  - { id: create, action: click, target: { by: role, role: button, name: Create } }
`)
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
      const take = await recordScenario(page, scenario, project, {
        outDir: join(mkdtempSync(join(tmpdir(), "kiframe-e2e-")), "take"),
        scope: "test",
        sceneId: "test",
        resolveSecret: () => "hunter2",
      })
      const { composition } = generate(project, scenario, take)
      expect(() => Composition.parse(composition)).not.toThrow()
      const { tracks } = composition
      expect(tracks.camera.length).toBeGreaterThan(0)
      expect(tracks.cursor.filter((c) => c.kind === "click-ripple")).toHaveLength(2)
      expect(tracks.captions.map((c) => c.id)).toEqual(["caption:open-new"])
      // The secret field is a region of the take (drawn at render time), never a mask here.
      expect(tracks.masks).toEqual([])
      expect(take.events.filter((e) => e.kind === "sensitive")).toHaveLength(1)
      expect(tracks.clips.some((c) => c.mode === "cut" && c.reason === "setup")).toBe(true)
    } finally {
      await browser.close()
      await server.close()
    }
  })
})
