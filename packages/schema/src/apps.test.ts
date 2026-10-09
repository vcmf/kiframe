import { describe, expect, it } from "vitest"
import {
  AppName,
  requiredSecrets,
  resolveProjectConfig,
  appOf,
  checkScenarioAgainstProject,
  parseScenarioYaml,
  startAppOf,
  unknownApps,
  firstApp,
  migrate,
  parseProjectJson,
  parseProjectYaml,
  Project,
  ProjectConfig,
  SchemaError,
  appIdentity,
  urlOf,
  webAppsOf,
} from "./index.ts"

// B1 (OBJECT-MODEL §0.9): a project's named apps replace its one target (project v2), and a v1
// project converts on read.

const app = (url: string) => ({ kind: "web", url, viewport: { width: 1440, height: 900 } })
const v2 = (apps: object, extra: object = {}) => ({
  version: 2,
  id: "p1",
  orgId: "org1",
  name: "Demo",
  apps,
  ...extra,
})
const v1 = (extra: object = {}) => ({
  version: 1,
  id: "p1",
  orgId: "org1",
  name: "Demo",
  target: app("https://www.minmux.dev"),
  sequence: ["intro"],
  ...extra,
})

describe("a project's apps", () => {
  it("lists named apps, the first being where a scene starts (as written, not sorted)", () => {
    const p = Project.parse(
      v2({ site: app("https://minmux.dev"), docs: app("https://docs.x.dev") }),
    )
    expect(firstApp(p).name).toBe("site")
    const z = Project.parse(v2({ zeta: app("https://z.dev"), alpha: app("https://a.dev") }))
    expect(firstApp(z)).toMatchObject({ name: "zeta", app: { url: "https://z.dev" } })
    // Written and read back: still first.
    expect(firstApp(parseProjectJson(JSON.stringify(z))).name).toBe("zeta")
  })

  it("gives an app a viewport when none is written", () => {
    const p = Project.parse(v2({ app: { kind: "web", url: "https://a.dev" } }))
    expect(p.apps.app?.viewport).toEqual({ width: 1440, height: 900, deviceScaleFactor: 2 })
  })

  it("needs one app, at most 20", () => {
    expect(Project.safeParse(v2({})).success).toBe(false)
    const many = Object.fromEntries(
      Array.from({ length: 21 }, (_, i) => [`a${i}`, app(`https://a${i}.dev`)]),
    )
    expect(Project.safeParse(v2(many)).success).toBe(false)
    // Thousands (a hostile file): refused at once, never compared pair by pair.
    const huge = Object.fromEntries(
      Array.from({ length: 3000 }, (_, i) => [`a${i}`, app(`https://a${i}.dev`)]),
    )
    const t = performance.now()
    expect(Project.safeParse(v2(huge)).success).toBe(false)
    expect(performance.now() - t).toBeLessThan(1000)
  })

  it("refuses names that aren't plain (integer-like, upper case, an object's own keys)", () => {
    for (const name of ["1", "123", "App", "-x", "constructor", "toString", "x".repeat(41)]) {
      expect(Project.safeParse(v2({ [name]: app("https://a.dev") })).success, name).toBe(false)
    }
    expect(() =>
      parseProjectJson(JSON.stringify(v2({})).replace('"apps":{}', '"apps":{"__proto__":{}}')),
    ).toThrow(SchemaError)
    // The name alone too (an app the agent names, before any document holds it).
    for (const name of ["constructor", "__proto__", "toString", "prototype"]) {
      expect(AppName.safeParse(name).success, name).toBe(false)
    }
    expect(AppName.safeParse("docs").success).toBe(true)
  })

  it("refuses two apps on one site (which app a page is on stays clear)", () => {
    const both = Project.safeParse(
      v2({ a: app("https://minmux.dev"), b: app("https://www.minmux.dev/x") }),
    )
    expect(both.success).toBe(false)
    expect(JSON.stringify(both.error?.issues)).toMatch(/same site/)
    expect(Project.safeParse(v2({ a: app("http://a.dev"), b: app("https://a.dev") })).success).toBe(
      false,
    )
    expect(
      Project.safeParse(v2({ a: app("https://minmux.dev"), b: app("https://docs.minmux.dev") }))
        .success,
    ).toBe(true)
  })

  it("finds an app by name, never a key every object has", () => {
    const p = Project.parse(v2({ app: app("https://a.dev") }))
    expect(appOf(p, "app")).toMatchObject({ url: "https://a.dev" })
    expect(appOf(p, "docs")).toBeUndefined()
    expect(appOf(p, "constructor")).toBeUndefined()
    expect(appOf(p, "__proto__")).toBeUndefined()
  })

  it("has no environment or target any more", () => {
    const apps = { app: app("https://a.dev") }
    expect(Project.safeParse(v2(apps, { environment: "staging" })).success).toBe(false)
    expect(Project.safeParse(v2(apps, { target: app("https://a.dev") })).success).toBe(false)
  })
})

describe("a v1 project, read", () => {
  it("becomes v2: its target the app named `app`, the rest as it was", () => {
    const p = parseProjectJson(JSON.stringify(v1()))
    expect(p.version).toBe(2)
    expect(p.apps).toEqual({
      app: {
        kind: "web",
        url: "https://www.minmux.dev",
        viewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
      },
    })
    expect(p.sequence).toEqual(["intro"])
    expect("target" in p).toBe(false)
  })

  it("never mutates what it reads", () => {
    const doc = v1()
    const copy = structuredClone(doc)
    migrate("project", doc)
    expect(doc).toEqual(copy)
  })

  it("is refused, saying what to do, when its address came from an environment", () => {
    const doc = v1({
      environment: "staging",
      target: { kind: "web", viewport: { width: 1440, height: 900 } },
    })
    expect(() => parseProjectJson(JSON.stringify(doc))).toThrow(SchemaError)
    expect(() => parseProjectJson(JSON.stringify(doc))).toThrow(/environment "staging".*"apps"/)
    // Whatever its target looks like (none at all, hand-edited).
    const { target: _gone, ...bare } = v1({ environment: "staging" })
    expect(() => parseProjectJson(JSON.stringify(bare))).toThrow(/environment "staging".*"apps"/)
  })

  it("leaves a malformed one to the schema (never a crash in the conversion)", () => {
    for (const target of [undefined, "https://a.dev", [1], null]) {
      expect(() => parseProjectJson(JSON.stringify(v1({ target })))).toThrow(SchemaError)
    }
    // Both `target` and `apps`: not silently merged, the schema refuses `target`.
    expect(() =>
      parseProjectJson(JSON.stringify(v1({ apps: { docs: app("https://d.dev") } }))),
    ).toThrow(/target/)
  })

  it("keeps a forbidden key inside the target for the guards to refuse", () => {
    const text = JSON.stringify(v1()).replace('"kind":"web"', '"__proto__":{"x":1},"kind":"web"')
    expect(() => parseProjectJson(text)).toThrow(SchemaError)
  })

  it("is refused when it comes from a newer Kiframe", () => {
    expect(() =>
      parseProjectJson(JSON.stringify(v2({ app: app("https://a.dev") }, { version: 3 }))),
    ).toThrow(/newer version/)
  })

  it("converts a resolved v1 config too (its environment name dropped, its URL kept)", () => {
    const config = parseProjectYaml(
      'version: 1\nenvironment: staging\ntarget: { kind: web, url: "https://s.dev", viewport: { width: 1280, height: 800 } }\n',
    )
    expect(ProjectConfig.parse(config).apps.app).toMatchObject({ url: "https://s.dev" })
    expect(firstApp(config).app.viewport.width).toBe(1280)
  })
})

describe("a scene that names apps (B2)", () => {
  const config = ProjectConfig.parse({
    version: 2,
    apps: { app: app("https://a.dev"), docs: app("https://docs.a.dev") },
    presets: { login: { app: "docs", steps: [{ action: "goto", url: "/in" }] } },
  })
  const scene = (yaml: string) => parseScenarioYaml(`version: 1\n${yaml}`)

  it("names its start app, a goto's app, a URL condition's app, a preset's app", () => {
    const s = scene(`app: docs
steps:
  - { id: a, action: goto, app: app, url: /x }
  - { id: b, action: waitFor, until: { url: /x, app: docs } }
`)
    expect(s.app).toBe("docs")
    expect(unknownApps(s, config)).toEqual([])
    expect(config.presets.login?.app).toBe("docs")
  })

  it("lists every app it uses that the project doesn't (start, gotos, conditions, presets; not the rules', an org's apply to every project, nor an older teardown's, never run)", () => {
    const withRule = ProjectConfig.parse({
      ...config,
      presets: { login: { app: "sso", steps: [{ action: "goto", app: "auth", url: "/" }] } },
      interrupts: [
        { id: "away", when: { text: "Moved" }, do: { action: "goto", app: "old", url: "/" } },
      ],
    })
    const s = scene(`app: nope
setup: [{ preset: login }, { action: goto, app: setup-app, url: / }]
steps:
  - { id: a, action: expect, that: { url: /x, app: cond } }
teardown: [{ action: goto, app: down, url: / }]
`)
    expect(
      unknownApps(s, withRule)
        .map((p) => /"(.+)"/.exec(p)?.[1])
        .sort(),
    ).toEqual(["auth", "cond", "nope", "setup-app", "sso"].sort())
    expect(checkScenarioAgainstProject(s, withRule)).toContain(
      `uses app "nope", which the project doesn't list`,
    )
  })

  it("keeps the hash of a scene that names no app (its takes stay its own)", () => {
    // The parsed scenario the hash is taken over, as main (before B2) wrote it for the same YAML.
    expect(JSON.stringify(scene("steps: [{ id: a, action: goto, url: /x }]"))).toBe(
      '{"version":1,"steps":[{"action":"goto","url":"/x","id":"a"}]}',
    )
    expect(
      JSON.stringify(
        scene(`setup: [{ action: goto, url: / }]
steps:
  - { id: w, action: waitFor, until: { url: /x } }
  - { id: e, action: expect, that: { url: /y } }`),
      ),
    ).toBe(
      '{"version":1,"setup":[{"action":"goto","url":"/"}],"steps":[{"action":"waitFor","until":{"url":"/x"},"id":"w"},{"action":"expect","that":{"url":"/y"},"id":"e"}]}',
    )
  })

  it("never counts what an older scene's teardown names: it never runs (no app, no secret)", () => {
    const s = scene(`steps: [{ id: a, action: pause, ms: 1 }]
teardown:
  - { action: goto, app: gone, url: / }
  - { id: pw, action: type, target: { by: label, name: Password }, value: "{{secrets.admin.password}}" }
`)
    expect(unknownApps(s, config)).toEqual([])
    const { environment } = resolveProjectConfig(
      Project.parse({ version: 2, id: "p", orgId: "o", name: "P", apps: config.apps }),
      undefined,
    )
    expect(requiredSecrets(config, environment, [s])).toEqual([])
  })

  it("starts in the app it names, else the first", () => {
    expect(startAppOf(scene("steps: [{ id: a, action: pause, ms: 1 }]"), config).name).toBe("app")
    expect(
      startAppOf(scene("app: docs\nsteps: [{ id: a, action: pause, ms: 1 }]"), config).name,
    ).toBe("docs")
    expect(() => startAppOf({ app: "nope" }, config)).toThrow(/isn't one of the project's apps/)
  })
})

describe("a desktop Electron app (design 2026-10-08)", () => {
  const desk = (extra: object = {}) => ({
    kind: "electron",
    bundleId: "com.example.notes",
    ...extra,
  })
  const parse = (apps: object) => Project.safeParse(v2(apps))

  it("is named by its bundle id, beside web apps (the viewport defaulted)", () => {
    const parsed = parse({ web: app("https://a.dev"), notes: desk({ args: ["files/demo"] }) })
    expect(parsed.success).toBe(true)
    const notes = parsed.data?.apps.notes
    expect(notes).toEqual({
      kind: "electron",
      bundleId: "com.example.notes",
      args: ["files/demo"],
      viewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
    })
    expect(appIdentity(notes!)).toBe("electron:com.example.notes")
    expect(Object.keys(webAppsOf(parsed.data!.apps))).toEqual(["web"])
    expect(() => urlOf(notes!)).toThrow("a desktop app (com.example.notes) has no address")
    expect(urlOf(parsed.data!.apps.web!)).toBe("https://a.dev")
  })

  it("never names a program: no path, no switch, a bundle id's form only", () => {
    const issue = (apps: object) => {
      const r = parse(apps)
      return r.success ? "parsed" : r.error.issues.map((i) => i.message).join("; ")
    }
    expect(issue({ x: desk({ path: "/bin/sh" }) })).not.toBe("parsed")
    expect(issue({ x: desk({ args: ["--inspect=9229"] }) })).toMatch(/positional arguments only/)
    expect(issue({ x: desk({ args: ["-e"] }) })).toMatch(/positional arguments only/)
    expect(issue({ x: desk({ bundleId: "/Applications/Notes.app" }) })).toMatch(/a bundle id/)
    expect(issue({ x: desk({ bundleId: "notes" }) })).toMatch(/a bundle id/)
    expect(issue({ x: desk({ url: "https://a.dev" }) })).not.toBe("parsed")
    // Chromium trims an argument before telling a switch: spaces and control characters too.
    for (const sneaky of [
      " --user-data-dir=/x",
      "\t--remote-debugging-address=0.0.0.0",
      "a\nb",
      "a ",
    ]) {
      expect(issue({ x: desk({ args: [sneaky] }) }), JSON.stringify(sneaky)).toMatch(
        /positional arguments only/,
      )
    }
    expect(issue({ x: desk({ args: ["files/My Demo"] }) })).toBe("parsed")
    // Only the project's files/ (never the user's own folders, never out of it).
    for (const outside of [
      "~/Demo",
      "/Users/me/Demo",
      "files",
      "files/../x",
      "files//x",
      "./files/x",
    ]) {
      expect(issue({ x: desk({ args: [outside] }) }), outside).toMatch(
        /a path in the project's files/,
      )
    }
    expect(issue({ x: desk({ bundleId: "1.0" }) })).toMatch(/a bundle id/)
  })

  it("takes a wrapper app's sites as https origins only", () => {
    expect(parse({ x: desk({ origins: ["https://app.slack.com"] }) }).success).toBe(true)
    for (const bad of ["http://app.slack.com", "https://app.slack.com/client", "file:///"]) {
      expect(parse({ x: desk({ origins: [bad] }) }).success, bad).toBe(false)
    }
  })

  it("is listed once per project (its bundle id in any case), its sites never a web app's", () => {
    const r = parse({ a: desk(), b: desk({ bundleId: "com.Example.Notes" }) })
    expect(r.success).toBe(false)
    expect(r.error?.issues[0]?.message).toBe(
      'apps "a" and "b" are the same desktop app: one app each',
    )
    const site = parse({
      slack: desk({ bundleId: "com.tinyspeck.slackmacgap", origins: ["https://app.slack.com"] }),
      web: app("https://app.slack.com"),
    })
    expect(site.error?.issues[0]?.message).toBe(
      'apps "slack" and "web" are on the same site: one app per site',
    )
    // Either order: the web app listed first too.
    const webFirst = parse({
      web: app("https://app.slack.com"),
      slack: desk({ bundleId: "com.tinyspeck.slackmacgap", origins: ["https://app.slack.com"] }),
    })
    expect(webFirst.error?.issues[0]?.message).toBe(
      'apps "web" and "slack" are on the same site: one app per site',
    )
  })

  it("never lets two wrapper apps claim one site (the issue on their origins)", () => {
    const both = parse({
      a: desk({ bundleId: "com.a.slack", origins: ["https://app.slack.com"] }),
      b: desk({ bundleId: "com.b.slack", origins: ["https://app.slack.com"] }),
    })
    expect(both.error?.issues[0]).toMatchObject({
      message: 'apps "a" and "b" are on the same site: one app per site',
      path: ["apps", "b", "origins"],
    })
  })
})
