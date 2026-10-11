import { describe, expect, it } from "vitest"
import {
  applyStyle,
  cardReadingMs,
  DEFAULT_STYLE,
  migrate,
  missingSecrets,
  requiredSecrets,
  OrgSettings,
  parseCompositionJson,
  parseOrgSettingsJson,
  parseProjectJson,
  parseScenarioYaml,
  parseSceneJson,
  parseUserPreferencesJson,
  Project,
  resolveFormat,
  resolveProjectConfig,
  resolveStyle,
  scenesOf,
  guideFormats,
  SchemaError,
  VersionError,
  type MigrationRegistry,
} from "./index.ts"

// M1-1: the v0 project model (project.json, scene.json, org settings, user preferences), the
// settings layers and document versioning.

const project = (extra: object = {}) => ({
  version: 2,
  id: "p1",
  orgId: "org1",
  name: "Q4 release",
  apps: {
    app: { kind: "web", url: "https://app.example.com", viewport: { width: 1440, height: 900 } },
  },
  sequence: ["intro", "create-project", "outro"],
  ...extra,
})

const org = (extra: object = {}) =>
  OrgSettings.parse({
    version: 1,
    environments: [
      {
        name: "staging",
        url: "https://staging.example.com",
        sandbox: true,
        preApproveTeardown: true,
        requiredSecrets: ["acme.email", "acme.password"],
      },
    ],
    rules: {
      interrupts: [
        {
          id: "cookies",
          when: { text: "Accept cookies" },
          do: { action: "click", target: { by: "text", text: "Accept" } },
        },
      ],
      hide: [".intercom-launcher"],
    },
    ...extra,
  })

describe("project.json", () => {
  it("parses a project with defaults filled in", () => {
    const p = parseProjectJson(JSON.stringify(project()))
    expect(p.outputs).toEqual([])
    expect(p.defaults.pacing.cursor).toBe("natural")
    expect(p.apps.app?.viewport.deviceScaleFactor).toBe(2)
  })

  it("rejects duplicates in the sequence and outputs that include unknown scenes", () => {
    expect(Project.safeParse(project({ sequence: ["a", "a"] })).success).toBe(false)
    const bad = Project.safeParse(
      project({ outputs: [{ id: "social", kind: "video", include: ["nope"] }] }),
    )
    expect(bad.success).toBe(false)
    expect(JSON.stringify(bad.error?.issues)).toMatch(/isn't in the sequence/)
  })

  it("keeps video-only fields off guides, and guide formats off videos", () => {
    expect(
      Project.safeParse(project({ outputs: [{ id: "g", kind: "guide", preset: "vertical" }] }))
        .success,
    ).toBe(false)
    expect(
      Project.safeParse(project({ outputs: [{ id: "v", kind: "video", formats: ["pdf"] }] }))
        .success,
    ).toBe(false)
    expect(
      Project.safeParse(
        project({ outputs: [{ id: "g", kind: "guide", formats: ["markdown", "pdf"] }] }),
      ).success,
    ).toBe(true)
  })

  it("rejects forbidden keys and secret references outside their slots (guards)", () => {
    expect(() => parseProjectJson('{"__proto__": {}, "version": 2}')).toThrow()
    expect(() =>
      parseProjectJson(JSON.stringify(project({ name: "{{secrets.acme.password}}" }))),
    ).toThrow()
  })

  it("doesn't quote the input in JSON syntax errors", () => {
    expect(() => parseProjectJson('{"name": "hunter2-secret"')).toThrow(/not valid JSON$/)
    try {
      parseProjectJson('{"name": "hunter2-secret"')
    } catch (error) {
      expect(String(error)).not.toMatch(/hunter2/)
    }
  })
})

describe("scene.json", () => {
  const scene = (extra: object) => ({ version: 1, id: "intro", title: "Welcome", ...extra })

  it("parses a recording and a card", () => {
    expect(
      parseSceneJson(JSON.stringify(scene({ source: { kind: "recording" } }))).duration,
    ).toEqual({
      mode: "auto",
    })
    const card = parseSceneJson(
      JSON.stringify(
        scene({ source: { kind: "card", template: "title", content: { heading: "Q4 release" } } }),
      ),
    )
    expect(card.source.kind).toBe("card")
  })

  it("keeps a recording's duration automatic, and bullets with the bullets template", () => {
    expect(() =>
      parseSceneJson(
        JSON.stringify(
          scene({ source: { kind: "recording" }, duration: { mode: "fixed", ms: 3000 } }),
        ),
      ),
    ).toThrow(/as long as its take/)
    expect(() =>
      parseSceneJson(
        JSON.stringify(
          scene({
            source: { kind: "card", template: "text", content: { heading: "H", bullets: ["a"] } },
          }),
        ),
      ),
    ).toThrow(/bullets template/)
    expect(() =>
      parseSceneJson(
        JSON.stringify(
          scene({ source: { kind: "card", template: "bullets", content: { heading: "H" } } }),
        ),
      ),
    ).toThrow(/bullets template/)
  })

  it("reads cards at 180 words per minute, at least 2 s", () => {
    expect(cardReadingMs({ heading: "Hi" })).toBe(2000)
    const long = { heading: "Word ".repeat(30).trim() }
    expect(cardReadingMs(long)).toBe(10_000)
  })
})

describe("org settings and user preferences", () => {
  it("rejects duplicate environments and pre-approved teardowns outside a sandbox", () => {
    const env = { name: "prod", url: "https://app.example.com" }
    expect(OrgSettings.safeParse({ version: 1, environments: [env, env] }).success).toBe(false)
    expect(
      OrgSettings.safeParse({ version: 1, environments: [{ ...env, preApproveTeardown: true }] })
        .success,
    ).toBe(false)
  })

  it("never accepts credentials in an environment URL", () => {
    expect(
      OrgSettings.safeParse({
        version: 1,
        environments: [{ name: "s", url: "https://bob:hunter2@staging.example.com" }],
      }).success,
    ).toBe(false)
  })

  it("parses org settings and user preferences from JSON with defaults", () => {
    expect(parseOrgSettingsJson('{"version": 1}').llm.policy).toBe("byok-allowed")
    expect(parseUserPreferencesJson('{"version": 1}')).toEqual({
      version: 1,
      language: "en",
      theme: "system",
    })
    for (const language of ["zh-Hant", "es-419", "fil", "pt-BR"]) {
      expect(parseUserPreferencesJson(JSON.stringify({ version: 1, language })).language).toBe(
        language,
      )
    }
  })
})

describe("settings layers", () => {
  it("takes the org's rule bank before the project's, never an environment's flags", () => {
    const p = Project.parse(
      project({
        interrupts: [
          // Same id as the org's rule: the project's replaces it.
          { id: "cookies", when: { text: "Cookies?" }, do: { action: "press", keys: "Escape" } },
        ],
        hide: [".intercom-launcher", ".beta-banner"],
      }),
    )
    const { config, environment } = resolveProjectConfig(p, org())
    expect(config.apps.app).toMatchObject({ url: "https://app.example.com" })
    expect(config.interrupts.map((r) => r.do.action)).toEqual(["press"])
    expect(config.hide).toEqual([".intercom-launcher", ".beta-banner"])
    // The org's sandbox environment gives the project nothing (no flag: nothing is pre-approved).
    expect(environment).toEqual({ url: "https://app.example.com", requiredSecrets: [] })
  })

  it("keeps an overridden org rule in its place (rules are tried in order)", () => {
    const o = org({
      rules: {
        interrupts: [
          { id: "cookies", when: { text: "Cookies" }, do: { action: "press", keys: "Escape" } },
          { id: "promo", when: { text: "Promo" }, do: { action: "press", keys: "Escape" } },
        ],
      },
    })
    const p = Project.parse(
      project({
        interrupts: [
          { id: "extra", when: { text: "Extra" }, do: { action: "press", keys: "Escape" } },
          { id: "cookies", when: { text: "Cookie wall" }, do: { action: "press", keys: "Enter" } },
        ],
      }),
    )
    const ids = resolveProjectConfig(p, o).config.interrupts.map((r) => [
      r.id,
      r.do.action === "press" && r.do.keys,
    ])
    expect(ids).toEqual([
      ["cookies", "Enter"],
      ["promo", "Escape"],
      ["extra", "Escape"],
    ])
  })

  it("counts every secret the project types", () => {
    const o = org({
      rules: {
        interrupts: [
          {
            id: "relogin",
            when: { text: "Session expired" },
            do: {
              action: "type",
              target: { by: "label", name: "Password" },
              value: "{{secrets.acme.password}}",
            },
          },
        ],
      },
    })
    const p = Project.parse(
      project({
        presets: {
          login: {
            session: true,
            steps: [
              {
                id: "token",
                action: "type",
                target: { by: "label", name: "Token" },
                value: "{{secrets.acme.token}}",
              },
            ],
          },
        },
      }),
    )
    const scene = parseScenarioYaml(
      'version: 1\nsteps:\n  - { id: key, action: type, target: { by: label, name: Key }, value: "{{secrets.acme.api_key}}" }\n',
    )
    const { config, environment } = resolveProjectConfig(p, o)
    expect(requiredSecrets(config, environment, [scene]).sort()).toEqual([
      "acme.api_key",
      "acme.password",
      "acme.token",
    ])
    expect(missingSecrets(requiredSecrets(config, environment), ["acme.token"])).toEqual([
      "acme.password",
    ])
  })

  it("works without org settings", () => {
    const { config, environment } = resolveProjectConfig(Project.parse(project()), undefined)
    expect(config.apps.app).toMatchObject({ url: "https://app.example.com" })
    expect(environment).toMatchObject({ requiredSecrets: [] })
  })

  it("layers styles field by field: defaults, org, project, output", () => {
    const p = Project.parse(
      project({
        style: { radius: 0, captions: { size: 44 } },
        outputs: [
          {
            id: "social",
            kind: "video",
            preset: "vertical",
            style: { captions: { position: "top" } },
          },
        ],
      }),
    )
    // The scene (its composition's style) sits between the project and the output.
    const style = resolveStyle(
      org({ style: { padding: 0.1 } }),
      p,
      { radius: 8, captions: { size: 40 } },
      p.outputs[0],
    )
    expect(style).toEqual({
      ...DEFAULT_STYLE,
      padding: 0.1,
      radius: 8,
      captions: { size: 40, position: "top" },
    })
    expect(applyStyle(DEFAULT_STYLE)).toEqual(DEFAULT_STYLE)
  })

  it("sizes videos from presets or explicit formats, and keeps outputs in sequence order", () => {
    const p = Project.parse(
      project({
        outputs: [
          { id: "social", kind: "video", preset: "vertical", include: ["outro", "intro"] },
          { id: "hd", kind: "video", format: { width: 1280, height: 720, fps: 60 } },
        ],
      }),
    )
    const [social, hd] = p.outputs
    expect(resolveFormat(social!)).toEqual({ width: 1080, height: 1920, fps: 30 })
    expect(resolveFormat(hd!)).toEqual({ width: 1280, height: 720, fps: 60 })
    expect(scenesOf(p, social!)).toEqual(["intro", "outro"])
    expect(scenesOf(p, hd!)).toEqual(["intro", "create-project", "outro"])
    expect(guideFormats({ id: "docs", kind: "guide" })).toEqual(["markdown"])
    // Portrait sizes go as far as landscape ones.
    expect(
      Project.safeParse(
        project({ outputs: [{ id: "p8k", kind: "video", format: { width: 4320, height: 7680 } }] }),
      ).success,
    ).toBe(true)
  })
})

describe("versioning", () => {
  it("refuses a document from a newer Kiframe, with a message saying so", () => {
    // A file-level problem like any other: a SchemaError, with the reason.
    expect(() => parseProjectJson(JSON.stringify(project({ version: 3 })))).toThrow(SchemaError)
    expect(() => parseCompositionJson('{"version": 7, "tracks": {}}')).toThrow(
      /newer version of Kiframe/,
    )
    expect(() => migrate("project", { version: 3 })).toThrow(VersionError)
  })

  it("upgrades older documents one version at a time, without mutating the input", () => {
    const registry: MigrationRegistry = {
      current: {
        project: 3,
        "project-config": 1,
        scene: 1,
        scenario: 1,
        composition: 1,
        "org-settings": 1,
        "user-preferences": 1,
      },
      migrations: {
        project: {
          1: (d) => ({ ...d, title: d.name }),
          2: (d) => {
            const { title, ...rest } = d
            return { ...rest, name: `${String(title)}!` }
          },
        },
      },
    }
    const input = { version: 1, name: "Q4" }
    const { doc, migrated } = migrate("project", input, registry)
    expect(doc).toEqual({ version: 3, name: "Q4!" })
    expect(migrated).toBe(true)
    expect(input).toEqual({ version: 1, name: "Q4" })
    expect(migrate("scene", { version: 1 }, registry).migrated).toBe(false)
  })

  it("reports a missing migration instead of guessing", () => {
    const registry: MigrationRegistry = {
      current: {
        project: 2,
        "project-config": 1,
        scene: 1,
        scenario: 1,
        composition: 1,
        "org-settings": 1,
        "user-preferences": 1,
      },
      migrations: {},
    }
    expect(() => migrate("project", { version: 1 }, registry)).toThrow(
      /no migration for project from version 1 to 2/,
    )
  })

  it("leaves documents without a usable version to their schema", () => {
    expect(migrate("project", { name: "x" }).doc).toEqual({ name: "x" })
    expect(() => parseProjectJson('{"name": "x"}')).toThrow(/Invalid project/)
  })
})
