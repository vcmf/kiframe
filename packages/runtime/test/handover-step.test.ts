import { mkdtempSync, readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseProjectYaml, parseScenarioYaml } from "@kiframe/schema"
import { type Browser, chromium } from "playwright"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { recordScenario, runScenario, StepError } from "../src/index.ts"
import { startFixtureServer } from "./fixture-server.ts"

// A handover step (setup only): the user does a part themselves; nothing they do is filmed.

let server: Awaited<ReturnType<typeof startFixtureServer>>
let browser: Browser
beforeAll(async () => {
  server = await startFixtureServer()
  browser = await chromium.launch()
})
afterAll(async () => {
  await browser.close()
  await server.close()
})

const project = () =>
  parseProjectYaml(`version: 2
apps: { app: { kind: web, url: "${server.url}", viewport: { width: 640, height: 400 } } }
defaults: { pacing: { settleMs: 0, cursor: instant, typing: instant } }
`)
const scenario = parseScenarioYaml(`version: 1
setup:
  - { action: goto, url: / }
  - { action: handover, task: "Enter the code", done_when: "the page is white again" }
steps:
  - { id: look, action: pause, ms: 300 }
`)

describe("a handover step", () => {
  it("asks the host with the run's page and task, and goes on once done", async () => {
    const page = await browser.newPage()
    const asked: { task: string; doneWhen?: string; same: boolean }[] = []
    await runScenario(page, scenario, project(), {
      requestHandover: (r) => {
        asked.push({
          task: r.task,
          ...(r.doneWhen !== undefined && { doneWhen: r.doneWhen }),
          same: r.page === page,
        })
        return Promise.resolve({ outcome: "done" as const })
      },
    })
    expect(asked).toEqual([
      { task: "Enter the code", doneWhen: "the page is white again", same: true },
    ])
    await page.close()
  })

  it("fails clearly when no one can answer (an unattended run), or the user couldn't", async () => {
    const page = await browser.newPage()
    const unattended = await runScenario(page, scenario, project()).catch((e: unknown) => e)
    expect(unattended).toBeInstanceOf(StepError)
    expect((unattended as StepError).reason).toBe("needs-user")
    const declined = await runScenario(page, scenario, project(), {
      requestHandover: () =>
        Promise.resolve({ outcome: "declined" as const, note: "no phone at hand" }),
    }).catch((e: unknown) => e)
    expect((declined as StepError).reason).toBe("handover-declined")
    // Their note goes with it (the agent asks them again knowing why).
    expect((declined as StepError).message).toMatch(/no phone at hand/)
    await page.close()
  })

  it("fails when the user can't do it even if the page closed meanwhile (never a silent success)", async () => {
    const page = await browser.newPage()
    const failed = await runScenario(page, scenario, project(), {
      requestHandover: async (r) => {
        await r.page.close()
        return { outcome: "declined" as const }
      },
    }).catch((e: unknown) => e)
    expect(failed).toBeInstanceOf(StepError)
    expect((failed as StepError).reason).toBe("handover-declined")
  })

  it("films nothing the user does (the capture stops for it)", async () => {
    const page = await browser.newPage({ viewport: { width: 640, height: 400 } })
    const outDir = join(mkdtempSync(join(tmpdir(), "kiframe-handover-")), "take")
    await recordScenario(page, scenario, project(), {
      outDir,
      keepFrames: true,
      requestHandover: async (r) => {
        // The user's moment: the page all red (what must never be in a frame), then white again.
        await r.page.evaluate(() => {
          document.documentElement.style.background = "rgb(255, 0, 0)"
          document.body.style.background = "rgb(255, 0, 0)"
        })
        await new Promise((r2) => setTimeout(r2, 800))
        // It ends on a page that stays still (green), drawn while frames are dropped: the take
        // must show it next all the same.
        await r.page.evaluate(() => {
          document.documentElement.style.background = "rgb(0, 200, 0)"
          document.body.style.background = "rgb(0, 200, 0)"
        })
        await new Promise((r2) => setTimeout(r2, 800))
        return { outcome: "done" as const }
      },
    })
    const files = readdirSync(join(outDir, "frames")).filter((f) => f.endsWith(".jpg"))
    expect(files.length).toBeGreaterThan(0)
    // Each frame's corner pixel, decoded by the browser itself.
    const check = await browser.newPage()
    const { reds, lastGreen } = await check.evaluate(
      async (datas: string[]) => {
        let red = 0
        let green = false
        for (const data of datas) {
          const img = new Image()
          img.src = `data:image/jpeg;base64,${data}`
          await img.decode()
          const canvas = document.createElement("canvas")
          canvas.width = img.width
          canvas.height = img.height
          const g = canvas.getContext("2d")!
          g.drawImage(img, 0, 0)
          const [r, gr, b] = g.getImageData(5, 5, 1, 1).data
          if (r! > 200 && gr! < 60 && b! < 60) red++
          green = r! < 60 && gr! > 150 && b! < 60
        }
        return { reds: red, lastGreen: green }
      },
      files.sort().map((f) => readFileSync(join(outDir, "frames", f)).toString("base64")),
    )
    expect(reds).toBe(0)
    // A still page after it: shown as it is (never the frame from before the handover).
    expect(lastGreen).toBe(true)
    await check.close()
    await page.close()
  }, 60_000)
})
