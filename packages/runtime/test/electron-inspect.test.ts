import { execFileSync } from "node:child_process"
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  codeDigest,
  DIGEST_LIMITS,
  inspectDesktopApp,
  parseSigning,
  placeRefusal,
  signatureHolds,
  teamRequirement,
} from "../src/electron-inspect.ts"
import { trialDesktopApp } from "../src/electron-trial.ts"

// Inspecting a desktop app the user picks (PR 3b): real bundles built from the repo's Electron (a
// clone, the fixture as its app, re-signed ad hoc: no hook in them), refused shapes beside.

const electron = createRequire(join(import.meta.dirname, "../../../apps/desktop/package.json"))(
  "electron",
) as string
const electronApp = electron.slice(0, electron.indexOf(".app/") + 4)
const fixture = join(import.meta.dirname, "fixtures/electron-app")

describe("where an app can't stay", () => {
  it("refuses what isn't an app, an app inside another, disk images, translocation, the Trash", () => {
    expect(placeRefusal("/Applications/Slack.app")).toBeUndefined()
    expect(placeRefusal("/Users/me/Apps/Tool.app")).toBeUndefined()
    expect(placeRefusal("/Applications/Slack")).toMatch(/isn't an app/)
    expect(placeRefusal("/Applications/Outer.app/Contents/Inner.app")).toMatch(/inside another/)
    expect(placeRefusal("/Volumes/Slack/Slack.app")).toMatch(/disk image/)
    expect(placeRefusal("/private/var/folders/x/y/T/AppTranslocation/ABC/d/Slack.app")).toMatch(
      /temporary copy/,
    )
    expect(placeRefusal("/Users/me/.Trash/Slack.app")).toMatch(/Trash/)
  })
})

describe("a signature", () => {
  it("reads unsigned, ad hoc and a developer's from codesign", () => {
    expect(parseSigning(1, "code object is not signed at all")).toEqual({ kind: "unsigned" })
    // Any other failure (a timeout, a codesign that can't read it): unread, never "unsigned".
    expect(parseSigning(-1, "")).toEqual({ kind: "unread" })
    expect(parseSigning(1, "invalid signature (code or signature have been modified)")).toEqual({
      kind: "unread",
    })
    expect(
      parseSigning(0, "Identifier=Electron\nSignature=adhoc\nTeamIdentifier=not set\n"),
    ).toEqual({
      kind: "adhoc",
    })
    expect(
      parseSigning(0, "Identifier=com.tinyspeck.slackmacgap\nTeamIdentifier=BQR82RBBHL\n"),
    ).toEqual({ kind: "team", team: "BQR82RBBHL", identifier: "com.tinyspeck.slackmacgap" })
  })

  it("requires the developer's team and the signed identifier, quoted", () => {
    expect(teamRequirement("BQR82RBBHL", 'a"b')).toBe(
      'anchor apple generic and identifier "a\\"b" and certificate leaf[subject.OU] = "BQR82RBBHL"',
    )
  })
})

// A pinned build's digest (any platform: plain folders).
describe("a pinned build's digest", () => {
  const tree = (entries: Record<string, string>, links: Record<string, string> = {}) => {
    const root = mkdtempSync(join(tmpdir(), "kiframe-el-digest-"))
    for (const [rel, content] of Object.entries(entries)) {
      mkdirSync(join(root, rel, ".."), { recursive: true })
      writeFileSync(join(root, rel), content)
    }
    for (const [rel, target] of Object.entries(links)) {
      mkdirSync(join(root, rel, ".."), { recursive: true })
      symlinkSync(target, join(root, rel))
    }
    return root
  }

  it("keeps links inside the bundle, and one leading nowhere", async () => {
    const root = tree(
      { "Versions/A/code": "x" },
      { "Versions/Current": "A", code: "Versions/Current/code", "bin/gone": "../pruned/cli.js" },
    )
    expect(await codeDigest(root)).toMatch(/^[0-9a-f]{64}$/)
  })

  it("refuses a link leading outside, however it gets there", async () => {
    for (const links of [
      { "lib.js": "/etc/hosts" },
      { "a/lib.js": "../../outside.js" },
      // Through an inner link: d is the root itself, so d/../x is above it.
      { d: ".", e: "d/../x" },
    ]) {
      await expect(
        codeDigest(tree({ "a/code": "x" }, links)),
        JSON.stringify(links),
      ).rejects.toThrow(/links outside itself/)
    }
  })

  it("never lets one tree pass for another (names can't forge entries)", async () => {
    const two = tree({ A: "X", B: "Y" })
    // One file whose name spells A's entry, A's byte and B's entry (in a plain "file name size
    // exec" encoding the two trees would read the same).
    const one = tree({ ["A 1 false\nXfile B"]: "Y" })
    expect(await codeDigest(two)).not.toBe(await codeDigest(one))
  })

  it("is the same through a link to the bundle, and changes with the code", async () => {
    const root = tree({ "a/code": "x" })
    const linked = join(mkdtempSync(join(tmpdir(), "kiframe-el-digest-link-")), "App.app")
    symlinkSync(root, linked)
    const digest = await codeDigest(root)
    expect(await codeDigest(linked)).toBe(digest)
    writeFileSync(join(root, "a/code"), "y")
    expect(await codeDigest(root)).not.toBe(digest)
  })

  it("refuses what isn't a file, what's too large, and stops when asked", async () => {
    const fifo = tree({ "a/code": "x" })
    execFileSync("mkfifo", [join(fifo, "a/pipe")])
    await expect(codeDigest(fifo)).rejects.toThrow(/isn't a file/)
    const limit = DIGEST_LIMITS.entries
    DIGEST_LIMITS.entries = 2
    try {
      await expect(codeDigest(tree({ "a/b": "1", "a/c": "2" }))).rejects.toThrow(/too large/)
    } finally {
      DIGEST_LIMITS.entries = limit
    }
    const stopping = new AbortController()
    stopping.abort()
    await expect(codeDigest(tree({ a: "1" }), stopping.signal)).rejects.toMatchObject({
      name: "AbortError",
    })
  })
})

describe.runIf(process.platform === "darwin")("an app's inspection", { timeout: 60_000 }, () => {
  let root: string
  let base: string
  // A real bundle: Electron cloned, the fixture as its app, its id and name its own, re-signed.
  const bundle = (name: string, change?: (app: string) => void, sign: string[] = []) => {
    const app = join(mkdtempSync(join(root, "app-")), `${name}.app`)
    execFileSync("cp", ["-cR", base, app])
    change?.(app)
    execFileSync("codesign", ["-s", "-", "-f", "--deep", ...sign, app], { stdio: "ignore" })
    return app
  }

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "kiframe-el-inspect-"))
    base = join(root, "Base.app")
    execFileSync("cp", ["-cR", electronApp, base])
    cpSync(fixture, join(base, "Contents/Resources/app"), { recursive: true })
    const plist = join(base, "Contents/Info.plist")
    execFileSync("plutil", [
      "-replace",
      "CFBundleIdentifier",
      "-string",
      "com.kiframe.fixture",
      plist,
    ])
    for (const key of ["CFBundleName", "CFBundleDisplayName"]) {
      execFileSync("plutil", ["-replace", key, "-string", "Kiframe Fixture", plist])
    }
  }, 120_000)

  afterAll(() => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true })
  })

  it("keeps an Electron app's id, name, versions and executable, pinned to its build", async () => {
    const app = bundle("Fixture")
    const seen = await inspectDesktopApp(app)
    expect(seen).toMatchObject({
      bundleId: "com.kiframe.fixture",
      name: "Kiframe Fixture",
      electron: "44.4.5",
      executable: join(seen.path, "Contents/MacOS/Electron"),
      signer: { kind: "pinned" },
    })
    // Any change to the code it runs: another build (its app, its framework).
    const edited = bundle("Edited", (a) =>
      writeFileSync(join(a, "Contents/Resources/app/index.html"), "<h1>changed</h1>"),
    )
    const digest = (await inspectDesktopApp(edited)).signer
    expect(digest).not.toEqual(seen.signer)
    // A helper app (where its pages and GPU run) changed: another build too.
    const helper = bundle("Helper", (a) => {
      const resources = join(
        a,
        "Contents/Frameworks/Electron Helper (Renderer).app/Contents/Resources",
      )
      mkdirSync(resources, { recursive: true })
      writeFileSync(join(resources, "added.js"), "changed")
    })
    expect((await inspectDesktopApp(helper)).signer).not.toEqual(seen.signer)
    expect(await codeDigest(seen.path)).toBe(
      seen.signer.kind === "pinned" ? seen.signer.digest : "",
    )
  })

  it("refuses an app that isn't Electron, a Mac App Store build, an executable that's a link", async () => {
    const notElectron = bundle("Plain", (a) =>
      rmSync(join(a, "Contents/Frameworks/Electron Framework.framework"), {
        recursive: true,
        force: true,
      }),
    )
    await expect(inspectDesktopApp(notElectron)).rejects.toThrow(/Electron apps only/)
    const entitlements = join(root, "sandbox.plist")
    writeFileSync(
      entitlements,
      '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>com.apple.security.app-sandbox</key><true/></dict></plist>',
    )
    // Inspected only, never launched (its own sandbox would crash it).
    const store = bundle("Store", undefined, ["--entitlements", entitlements])
    await expect(inspectDesktopApp(store)).rejects.toThrow(/Mac App Store build/)
    // Swapped after signing (codesign won't sign it so).
    const linked = bundle("Linked")
    const exe = join(linked, "Contents/MacOS/Electron")
    rmSync(exe)
    symlinkSync("/bin/sh", exe)
    await expect(inspectDesktopApp(linked)).rejects.toThrow(/executable isn't its own/)
  })

  it("names an app with an empty display name by its bundle name", async () => {
    const app = bundle("Unnamed", (a) =>
      execFileSync("plutil", [
        "-replace",
        "CFBundleDisplayName",
        "-string",
        "",
        join(a, "Contents/Info.plist"),
      ]),
    )
    expect((await inspectDesktopApp(app)).name).toBe("Kiframe Fixture")
  })

  it("refuses a pinned app that links outside itself, or can't be read whole", async () => {
    // After signing (code a link leads to outside the bundle: what the pin couldn't cover).
    const outside = bundle("Outside")
    symlinkSync("/etc/hosts", join(outside, "Contents/Resources/shared.js"))
    await expect(inspectDesktopApp(outside)).rejects.toThrow(/links outside itself/)
    const unreadable = bundle("Unreadable")
    const locked = join(unreadable, "Contents/Resources/app/index.html")
    chmodSync(locked, 0o000)
    try {
      await expect(inspectDesktopApp(unreadable)).rejects.toThrow(/can't be read whole \(EACCES\)/)
    } finally {
      chmodSync(locked, 0o644)
    }
  })

  it("refuses an app inside another app", async () => {
    const outer = join(mkdtempSync(join(root, "outer-")), "Outer.app")
    mkdirSync(join(outer, "Contents"), { recursive: true })
    const inner = join(outer, "Contents", "Inner.app")
    execFileSync("cp", ["-cR", bundle("Inner"), inner])
    await expect(inspectDesktopApp(inner)).rejects.toThrow(/inside another app/)
    await expect(inspectDesktopApp(join(root, "Gone.app"))).rejects.toThrow(/can't be read/)
  })

  // A bundle whose app runs the fixture in a mode (a shim as its main: no argument from Kiframe).
  const withMode = (name: string, mode: string) =>
    bundle(name, (a) => {
      const dir = join(a, "Contents/Resources/app")
      writeFileSync(
        join(dir, "mode.cjs"),
        `process.argv.push(${JSON.stringify(mode)}, "hidden")\nrequire("./main.cjs")\n`,
      )
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "kiframe-fixture-electron", main: "mode.cjs" }),
      )
    })

  it("tries an app confined: driven, a wrapper's site named, one that quits said", async () => {
    const work = mkdtempSync(join(tmpdir(), "kiframe-el-work-"))
    const app = await inspectDesktopApp(withMode("Notes", "plain"))
    expect(await trialDesktopApp(app, { workDir: work })).toEqual({ ok: true })
    const wrapper = await inspectDesktopApp(withMode("Wrapper", "wrapper"))
    // Its site named, even unreached (where its window failed to go).
    expect(await trialDesktopApp(wrapper, { workDir: work })).toEqual({
      site: "https://kiframe-wrapper.invalid",
    })
    // Listed, unreachable: said as a failed load (a real one loads, in electron.test.ts).
    expect(
      await trialDesktopApp(wrapper, {
        workDir: work,
        origins: ["https://kiframe-wrapper.invalid"],
      }),
    ).toMatchObject({ failed: expect.stringMatching(/couldn't load/) as string })
    const quits = await inspectDesktopApp(withMode("Quits", "quit-at-once"))
    expect(await trialDesktopApp(quits, { workDir: work })).toEqual({ quit: true })
    // Nothing left of any trial.
    expect(readdirSync(join(work, "sandboxes"))).toEqual([])
  })

  it("holds an app to the build that was picked (a pinned one rebuilt: changed)", async () => {
    const path = withMode("Rebuilt", "plain")
    const app = await inspectDesktopApp(path)
    expect(await signatureHolds(app.path, app.signer)).toBe(true)
    writeFileSync(join(path, "Contents/Resources/app/index.html"), "<h1>rebuilt</h1>")
    expect(await signatureHolds(app.path, app.signer)).toBe(false)
    // Never tried as the build that was picked.
    expect(
      await trialDesktopApp(app, { workDir: mkdtempSync(join(tmpdir(), "kiframe-el-work-")) }),
    ).toEqual({ failed: "the app changed since it was picked: pick it again" })
  })

  it("stops an inspection when asked", async () => {
    const stopping = new AbortController()
    stopping.abort()
    await expect(inspectDesktopApp(bundle("Stop"), stopping.signal)).rejects.toMatchObject({
      name: "AbortError",
    })
  })

  it("throws a stop as the stop", async () => {
    const app = await inspectDesktopApp(withMode("Stopped", "plain"))
    const stopping = new AbortController()
    stopping.abort()
    await expect(
      trialDesktopApp(app, {
        workDir: mkdtempSync(join(tmpdir(), "kiframe-el-work-")),
        signal: stopping.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" })
  })
})
