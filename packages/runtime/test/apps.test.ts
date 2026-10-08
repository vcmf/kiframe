import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseProjectYaml, parseScenarioYaml, type ProjectConfig } from "@kiframe/schema"
import { memoryBackend, Vault } from "@kiframe/vault"
import { chromium, type Browser, type Page } from "playwright"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import {
  type ApprovalRequest,
  recordBatch,
  recordScenario,
  runScenario,
  StepError,
} from "../src/index.ts"
import { expandSetup } from "../src/run/setup.ts"
import { startFixtureServer } from "./fixture-server.ts"

// B2 (OBJECT-MODEL §0.9): a scene moves between the project's apps. Two apps on one fixture
// server: 127.0.0.1 and localhost are two sites (two origins, not one another's www. alias).

let server: Awaited<ReturnType<typeof startFixtureServer>>
let browser: Browser
let page: Page
let project: ProjectConfig
let app: URL
let docs: URL

beforeAll(async () => {
  server = await startFixtureServer()
  browser = await chromium.launch()
  app = new URL(server.url)
  docs = new URL(server.url)
  docs.hostname = "localhost"
  project = parseProjectYaml(`version: 2
apps:
  app: { kind: web, url: "${app.origin}", viewport: { width: 800, height: 600 } }
  docs: { kind: web, url: "${docs.origin}", viewport: { width: 800, height: 600 } }
defaults: { pacing: { settleMs: 0, cursor: instant, typing: instant } }
`)
})
afterAll(async () => {
  await browser.close()
  await server.close()
})
beforeEach(async () => {
  const context = await browser.newContext({ viewport: { width: 800, height: 600 } })
  page = await context.newPage()
  return () => context.close()
})

const scene = (yaml: string) => parseScenarioYaml(`version: 1\n${yaml}`)
const run = (yaml: string, options = {}) => runScenario(page, scene(yaml), project, options)
const host = () => new URL(page.url()).host

describe("a scene across the project's apps", () => {
  it("goes to the app a goto names; a plain goto means the scene's start app", async () => {
    await run(`setup: [{ action: goto, url: / }]
steps:
  - { id: docs, action: goto, app: docs, url: /projects }
  - { id: more, action: goto, app: docs, url: /login }
`)
    expect(host()).toBe(docs.host)
    await run(`steps:
  - { id: docs, action: goto, app: docs, url: /projects }
  - { id: login, action: goto, url: /login }
`)
    expect(host()).toBe(app.host)
  })

  it("starts in the app the scene names (its first goto relative to it)", async () => {
    await run(`app: docs
setup: [{ action: goto, url: /login }]
steps: [{ id: wait, action: pause, ms: 1 }]
`)
    expect(host()).toBe(docs.host)
  })

  it("never moves the scene's app by a link: a plain goto still means the scene's", async () => {
    await run(`setup: [{ action: goto, url: /swap-host }]
steps:
  - { id: other, action: click, target: { by: role, role: link, name: Other host } }
  - { id: there, action: waitFor, until: { url: /projects, app: docs } }
  - { id: login, action: goto, url: /login }
`)
    expect(host()).toBe(app.host)
  })

  it("means the same app for a step run alone (grounding) as in the whole scene", async () => {
    await run(`steps: [{ id: docs, action: goto, app: docs, url: / }]`)
    await run(`steps: [{ id: login, action: goto, url: /login }]`)
    expect(host()).toBe(app.host)
  })

  it("matches a URL condition against the app it names, else the scene's start app", async () => {
    await run(`steps:
  - { id: docs, action: goto, app: docs, url: /projects }
  - { id: named, action: expect, that: { url: /projects, app: docs } }
`)
    const other = run(
      `steps:
  - { id: docs, action: goto, app: docs, url: /projects }
  - { id: plain, action: expect, that: { url: /projects } }
`,
      { timeoutMs: 300 },
    )
    await expect(other).rejects.toThrow(StepError)
  })

  it("refuses an app the project doesn't list, before anything runs", async () => {
    for (const yaml of [
      `app: nope\nsteps: [{ id: a, action: goto, url: / }]`,
      `steps: [{ id: a, action: goto, app: nope, url: / }]`,
      `steps: [{ id: a, action: waitFor, until: { url: /, app: nope } }]`,
    ]) {
      const error = await run(yaml).catch((e: unknown) => e)
      expect(error instanceof StepError && error.reason, yaml).toBe("invalid-setup")
      expect(page.url()).toBe("about:blank")
    }
  })

  it("refuses a secret on a blank page as off the project's apps", async () => {
    // about:blank with a password field (its origin is opaque: "null").
    await page.setContent(`<label>Password <input type="password"></label>`)
    const blind = { resolveSecret: () => "hunter2-secret", scope: "p", sceneId: "s" }
    const error = await run(
      `steps:
  - { id: pw, action: type, target: { by: label, name: Password }, value: "{{secrets.acme.password}}" }`,
      { ...blind, timeoutMs: 300 },
    ).catch((e: unknown) => e)
    expect(error instanceof StepError && error.reason).toBe("off-origin")
    expect(await page.getByLabel("Password").inputValue()).toBe("")
  })

  it("runs an interrupt rule's goto in the first app, wherever the scene is", async () => {
    const withRule = parseProjectYaml(`version: 2
apps:
  app: { kind: web, url: "${app.origin}" }
  docs: { kind: web, url: "${docs.origin}" }
defaults: { pacing: { settleMs: 0, cursor: instant, typing: instant } }
interrupts:
  - { id: away, when: { text: Clean }, do: { action: goto, url: /login } }
`)
    await runScenario(
      page,
      scene(`app: docs
steps:
  - { id: docs, action: goto, url: /clean }
  - { id: a, action: pause, ms: 1 }
`),
      withRule,
    )
    expect(host()).toBe(app.host)
    expect(new URL(page.url()).pathname).toBe("/login")
  })

  it("gives the scene its own app back after a preset (one without an app means the first)", async () => {
    const withPreset = parseProjectYaml(`version: 2
apps:
  app: { kind: web, url: "${app.origin}" }
  docs: { kind: web, url: "${docs.origin}" }
defaults: { pacing: { settleMs: 0, cursor: instant, typing: instant } }
presets:
  login: { steps: [{ action: goto, url: /login }] }
`)
    await runScenario(
      page,
      scene(`app: docs
setup: [{ preset: login }, { action: goto, url: /projects }]
steps: [{ id: a, action: pause, ms: 1 }]`),
      withPreset,
    )
    expect(host()).toBe(docs.host)
  })

  it("starts a preset's steps in its app", async () => {
    const withPreset = parseProjectYaml(`version: 2
apps:
  app: { kind: web, url: "${app.origin}" }
  docs: { kind: web, url: "${docs.origin}" }
defaults: { pacing: { settleMs: 0, cursor: instant, typing: instant } }
presets:
  open-docs: { app: docs, steps: [{ action: goto, url: /login }] }
`)
    const seen: string[] = []
    page.on("framenavigated", (f) => {
      if (f === page.mainFrame()) seen.push(f.url())
    })
    await runScenario(
      page,
      scene(`setup: [{ preset: open-docs }]\nsteps: [{ id: a, action: goto, url: /projects }]`),
      withPreset,
    )
    // The preset's goto on docs; the scene's own after it on the scene's app.
    expect(seen).toEqual([`${docs.origin}/login`, `${app.origin}/projects`])
  })
})

describe("a secret across the project's apps", () => {
  const typeIt = `  - { id: pw, action: type, target: { by: label, name: Password }, value: "{{secrets.acme.password}}" }`

  // The vault holds a secret added for `app` (its origin), and the user approves every use.
  const withVault = async () => {
    const vault = Vault.open(
      join(mkdtempSync(join(tmpdir(), "kiframe-apps-vault-")), "vault.json"),
      memoryBackend(),
    )
    await vault.request(
      { name: "acme.password", kind: "password", origin: app.origin, reason: "test" },
      () => Promise.resolve("hunter2-secret"),
    )
    return {
      scope: "p",
      sceneId: "s",
      resolveSecret: vault.resolver(),
      requestApproval: async (request: ApprovalRequest) => (
        await vault.approve(request.secret, request.use),
        true
      ),
    }
  }

  it("is typed on the app it was added for", async () => {
    await run(`setup: [{ action: goto, url: /pw }]\nsteps:\n${typeIt}`, await withVault())
    expect(await page.getByLabel("Password").inputValue()).toBe("hunter2-secret")
  })

  it("is never typed on another of the project's apps", async () => {
    const error = await run(
      `setup: [{ action: goto, app: docs, url: /pw }]\nsteps:\n${typeIt}`,
      await withVault(),
    ).catch((e: unknown) => e)
    expect(error instanceof StepError && error.reason).toBe("secret-refused")
    expect(await page.getByLabel("Password").inputValue()).toBe("")
  })

  it("is never typed off the project's apps, whatever the resolver (one that never checks)", async () => {
    // The project lists `app` only; a link takes the page to a password field on another site.
    const one = parseProjectYaml(`version: 2
apps: { app: { kind: web, url: "${app.origin}" } }
defaults: { pacing: { settleMs: 0, cursor: instant, typing: instant } }
`)
    // The secret check alone (a step leaving the apps fails before it, `confine`: off here).
    const blind = {
      resolveSecret: () => "hunter2-secret",
      scope: "p",
      sceneId: "s",
      confineToApps: false,
    }
    const error = await runScenario(
      page,
      scene(`setup: [{ action: goto, url: "/swap-host?to=/pw" }]
steps:
  - { id: away, action: click, target: { by: role, role: link, name: Other host } }
  - { id: there, action: waitFor, until: { visible: { by: label, name: Password } } }
${typeIt}`),
      one,
      blind,
    ).catch((e: unknown) => e)
    expect(new URL(page.url()).host).toBe(docs.host)
    expect(error instanceof StepError && error.reason).toBe("off-origin")
    expect(await page.getByLabel("Password").inputValue()).toBe("")
  })
})

describe("takes and sessions across the project's apps", () => {
  it("names the app a take starts in, and films it at that app's size", async () => {
    const sized = parseProjectYaml(`version: 2
apps:
  app: { kind: web, url: "${app.origin}", viewport: { width: 800, height: 600 } }
  docs: { kind: web, url: "${docs.origin}", viewport: { width: 640, height: 480 } }
defaults: { pacing: { settleMs: 0, cursor: instant, typing: instant } }
`)
    const context = await browser.newContext({ viewport: { width: 640, height: 480 } })
    try {
      const take = await recordScenario(
        await context.newPage(),
        scene(
          "app: docs\nsetup: [{ action: goto, url: /login }]\nsteps: [{ id: a, action: pause, ms: 50 }]",
        ),
        sized,
        { outDir: join(mkdtempSync(join(tmpdir(), "kiframe-apps-take-")), "take") },
      )
      expect([take.meta.app, take.meta.appUrl]).toEqual(["docs", docs.origin])
    } finally {
      await context.close()
    }
  })

  it("records each scene of a batch at the size of the app it starts in", async () => {
    const sized = parseProjectYaml(`version: 2
apps:
  app: { kind: web, url: "${app.origin}", viewport: { width: 800, height: 600 } }
  docs: { kind: web, url: "${docs.origin}", viewport: { width: 640, height: 480 } }
defaults: { pacing: { settleMs: 0, cursor: instant, typing: instant } }
`)
    const dir = mkdtempSync(join(tmpdir(), "kiframe-apps-batch-"))
    const results = await recordBatch(
      browser,
      ["", "app: docs\n"].map((start, i) => ({
        scenario: scene(
          `${start}setup: [{ action: goto, url: /login }]\nsteps: [{ id: a, action: pause, ms: 50 }]`,
        ),
        outDir: join(dir, `take-${i}`),
        sceneId: `scene-${i}`,
      })),
      sized,
    )
    expect(
      results.map((r) => (r.ok ? [r.take.meta.app, r.take.meta.viewport.width] : r.error)),
    ).toEqual([
      ["app", 800],
      ["docs", 640],
    ])
  })

  it("refuses a batch scene naming an app the project doesn't list, as a single run does", async () => {
    const [result] = await recordBatch(
      browser,
      [
        {
          scenario: scene("app: nope\nsteps: [{ id: a, action: pause, ms: 1 }]"),
          outDir: join(mkdtempSync(join(tmpdir(), "kiframe-apps-nope-")), "take"),
          sceneId: "nope",
        },
      ],
      project,
    )
    expect(result?.ok === false && result.error instanceof StepError && result.error.reason).toBe(
      "invalid-setup",
    )
  })

  it("goes back to where a skipped session preset ended, in its app", () => {
    const entries = expandSetup(
      [{ preset: "login" }],
      parseProjectYaml(`version: 2
apps:
  app: { kind: web, url: "${app.origin}" }
  docs: { kind: web, url: "${docs.origin}" }
presets: { login: { session: true, steps: [{ action: goto, url: /login }] } }
`),
      ["login"],
      { login: { app: "docs", url: "/projects?tab=1" } },
      "app",
    )
    // The landing's goto means its app; the scene's own comes back after it. Then the preset's
    // end, held (its state saved again: no login ran).
    expect(entries.map((e) => [e.kind, "app" in e ? e.app : undefined])).toEqual([
      ["action", "docs"],
      ["preset_done", undefined],
    ])
    expect(entries.at(-1)).toMatchObject({ kind: "preset_done", held: true })
  })
})

describe("a reused session's checks", () => {
  const project = () =>
    parseProjectYaml(`version: 2
apps: { app: { kind: web, url: "${app.origin}" } }
presets:
  login:
    session: true
    steps:
      - { action: goto, url: /login }
      - { action: expect, that: { visible: { by: text, text: Signed in } } }
`)
  it("run under the landing's setup index (they add none: a later step's index as without them)", () => {
    const reused = expandSetup(
      [{ preset: "login" }, { action: "goto", url: "/x" }],
      project(),
      ["login"],
      { login: { app: "app", url: "/home" } },
      "app",
    )
    // The landing (0), its check under the same index (0), the scene's own step after (1).
    expect(reused.filter((e) => e.kind === "action").map((e) => e.index)).toEqual([0, 0, 1])
  })
})

describe("the app each setup step means, worked out from the text", () => {
  const project = parseProjectYaml(`version: 2
apps:
  app: { kind: web, url: "https://a.test" }
  docs: { kind: web, url: "https://d.test" }
  auth: { kind: web, url: "https://auth.test" }
presets:
  login: { app: auth, steps: [{ action: goto, url: /in }, { action: goto, app: app, url: /x }, { action: goto, url: /y }] }
  plain: { steps: [{ action: goto, url: /p }] }
`)
  it("gives a preset's steps its app (the first by default), every other step the scene's start app", () => {
    const entries = expandSetup(
      parseScenarioYaml(`version: 1
setup:
  - { action: goto, url: /a }
  - { preset: login }
  - { action: goto, url: /b }
  - { preset: plain }
  - { action: goto, app: docs, url: /c }
  - { action: goto, url: /d }
  - ensure: { absent: { by: text, text: Draft } }
steps: [{ id: s, action: pause, ms: 1 }]`).setup ?? [],
      project,
      [],
      {},
      "docs",
    )
    expect(
      entries.flatMap((e) =>
        e.kind === "action" && e.action.action === "goto" ? [`${e.app} ${e.action.url}`] : [],
      ),
    ).toEqual([
      "docs /a",
      "auth /in",
      "auth /x",
      "auth /y",
      "docs /b",
      "app /p",
      "docs /c",
      "docs /d",
    ])
  })
})

describe("a step off the project's apps (B4)", () => {
  // The project lists `app` (127.0.0.1) only: localhost is another site.
  const one = () =>
    parseProjectYaml(`version: 2
apps: { app: { kind: web, url: "${app.origin}" } }
defaults: { pacing: { settleMs: 0, cursor: instant, typing: instant } }
`)
  const leave = `setup: [{ action: goto, url: "/swap-host?to=/login" }]
steps:
  - { id: away, action: click, target: { by: role, role: link, name: Other host } }
  - { id: after, action: pause, ms: 1 }
`

  it("fails the step that ended on another site, naming it", async () => {
    const error = await runScenario(page, scene(leave), one()).catch((e: unknown) => e)
    expect(error instanceof StepError && [error.reason, error.step.stepId]).toEqual([
      "off-app",
      "away",
    ])
    expect((error as StepError).message).toContain(docs.host)
  })

  it("lets a step grounded on the live page go there (it says where it went)", async () => {
    await runScenario(page, scene(leave), one(), { confineToApps: false })
    expect(host()).toBe(docs.host)
  })

  it("passes a step whose redirect comes back to the app in a moment", async () => {
    // /nav-back: a page on the other site that sends the browser back to the app after 300 ms.
    await runScenario(
      page,
      scene(`setup: [{ action: goto, url: "/swap-host?to=/bounce" }]
steps: [{ id: away, action: click, target: { by: role, role: link, name: Other host } }]
`),
      one(),
    )
    expect(host()).toBe(app.host)
  })

  it("checks what a tab a step opened loads (never passing it while it's still blank)", async () => {
    const error = await runScenario(
      page,
      scene(`setup: [{ action: goto, url: /swap-tab }]
steps:
  - { id: tab, action: click, target: { by: role, role: link, name: Other host } }
`),
      one(),
    ).catch((e: unknown) => e)
    expect(error instanceof StepError && [error.reason, error.step.stepId]).toEqual([
      "off-app",
      "tab",
    ])
  })

  it("ends a wait for the page to come back as a stop when the run is stopped", async () => {
    const controller = new AbortController()
    const run = runScenario(page, scene(leave), one(), {
      signal: controller.signal,
      onEvent: (e) => {
        if (e.kind === "step_start" && e.step.stepId === "away") {
          setTimeout(() => controller.abort(), 400)
        }
      },
    }).catch((e: unknown) => e)
    const started = Date.now()
    const error = await run
    expect(error instanceof StepError && error.reason).toBe("stopped")
    // Ended by the stop, not by the wait running out (2.5 s).
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it("fails a step that ends on a page that didn't load (never passing it as on the app)", async () => {
    const error = await runScenario(
      page,
      scene(`setup: [{ action: goto, url: /dead-link }]
steps: [{ id: dead, action: click, target: { by: role, role: link, name: Nowhere } }]
`),
      one(),
    ).catch((e: unknown) => e)
    expect(error instanceof StepError && [error.reason, error.message]).toEqual([
      "action-failed",
      expect.stringContaining("the page failed to load") as unknown,
    ])
  })
})
