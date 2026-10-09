import { createHash } from "node:crypto"
import { constants, createReadStream } from "node:fs"
import { access, lstat, readdir, readlink, realpath } from "node:fs/promises"
import { basename, join } from "node:path"
import { command as run } from "./electron-workarea.ts"

// A desktop app the user picks, inspected before Kiframe ever runs it (PR 3b, design reviewed
// 2026-10-09): only plutil and codesign run, nothing of the app. What's refused is said as is;
// what's kept is what an approval pins (its developer, or the exact build of an unsigned one).

/**
 * Who stands behind the app: a developer (Apple team id; `identifier` the signing identifier, kept
 * for the signature check) or no one (ad hoc or unsigned: pinned to a digest of its code).
 */
export type Signer =
  { kind: "team"; team: string; identifier: string } | { kind: "pinned"; digest: string }

export interface DesktopApp {
  /** The bundle's real path. */
  path: string
  bundleId: string
  /** Its name as shown (Finder's). */
  name: string
  version: string | undefined
  /** Electron's version in it (shown, never a condition: the confined trial decides). */
  electron: string
  /** The executable's real path, inside the bundle. */
  executable: string
  signer: Signer
}

/** An app Kiframe won't add: said to the user as is. */
export class InspectError extends Error {}

const BUNDLE_ID = /^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z0-9-]+)+$/

/** codesign on a large bundle (a verify reads it all) can take a while: never forever. */
const TIMEOUT = 60_000

/** Why an app can't be used from where it is (its real path), or undefined. */
export function placeRefusal(real: string): string | undefined {
  if (!real.endsWith(".app")) return "that isn't an app (a .app)"
  if (real.slice(0, -4).includes(".app/"))
    return "that app is inside another app: pick the app itself"
  if (real.startsWith("/Volumes/")) {
    return "that app is on a disk image or another disk: copy it to Applications first"
  }
  if (real.includes("/AppTranslocation/")) {
    return "macOS runs that app from a temporary copy: move it to Applications, open it once, then add it"
  }
  if (real.includes("/.Trash/")) return "that app is in the Trash"
  return undefined
}

/** A value of an Info.plist (undefined when it has none), read by plutil. */
async function plistValue(plist: string, key: string): Promise<string | undefined> {
  const out = await run("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plist], TIMEOUT)
  // An empty value is no value (a build with an empty name: its fallback instead).
  const value = out.code === 0 ? out.stdout.trim() : ""
  return value === "" ? undefined : value
}

/**
 * What `codesign -dv` says of a signature: unsigned (it says so), ad hoc, a developer's, or unread
 * (it failed otherwise, timed out: never taken for "unsigned").
 */
export function parseSigning(
  code: number,
  stderr: string,
):
  | { kind: "unsigned" }
  | { kind: "adhoc" }
  | { kind: "team"; team: string; identifier: string }
  | { kind: "unread" } {
  if (code !== 0)
    return /not signed at all/.test(stderr) ? { kind: "unsigned" } : { kind: "unread" }
  const field = (name: string) => new RegExp(`^${name}=(.*)$`, "m").exec(stderr)?.[1]?.trim()
  const team = field("TeamIdentifier")
  const identifier = field("Identifier")
  if (field("Signature") === "adhoc" || team === undefined || team === "not set") {
    return { kind: "adhoc" }
  }
  return { kind: "team", team, identifier: identifier ?? "" }
}

/** The requirement a developer's signature must meet: their team, the signed identifier. */
export function teamRequirement(team: string, identifier: string): string {
  const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
  return `anchor apple generic and identifier ${q(identifier)} and certificate leaf[subject.OU] = ${q(team)}`
}

/** Whether the bundle's signature is whole and its developer's (`codesign --verify --strict`). */
export async function signatureHolds(path: string, signer: Signer): Promise<boolean> {
  if (signer.kind !== "team") return true
  const out = await run(
    "/usr/bin/codesign",
    ["--verify", "--strict", `-R=${teamRequirement(signer.team, signer.identifier)}`, path],
    TIMEOUT,
  )
  return out.code === 0
}

/** A pinned build's limits (hashed when it's picked, and before each run). */
export const DIGEST_LIMITS = { bytes: 4 * 1024 * 1024 * 1024, entries: 200_000 }

/**
 * The code an unsigned app runs, hashed: the whole bundle, what pins the exact build (any change: a
 * new digest). A link is kept as a link only when it stays inside the bundle (its target hashed as
 * part of it); one leading outside is refused (code the pin couldn't cover). Unreadable, too large
 * or stopped: refused, said.
 */
export async function codeDigest(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256")
  let bytes = 0
  let entries = 0
  const add = async (rel: string) => {
    signal?.throwIfAborted()
    const full = rel === "" ? path : join(path, rel)
    const stat = await lstat(full)
    entries += 1
    if (entries > DIGEST_LIMITS.entries) throw new InspectError("that app is too large to pin")
    if (stat.isSymbolicLink()) {
      const target = await realpath(full).catch(() => undefined)
      if (target === undefined || (target !== path && !target.startsWith(`${path}/`))) {
        throw new InspectError(`that app links outside itself (${rel}): Kiframe can't pin it`)
      }
      hash.update(`link ${rel} ${await readlink(full)}\n`)
    } else if (stat.isDirectory()) {
      for (const name of (await readdir(full)).sort())
        await add(rel === "" ? name : join(rel, name))
    } else if (stat.isFile()) {
      bytes += stat.size
      if (bytes > DIGEST_LIMITS.bytes) throw new InspectError("that app is too large to pin")
      hash.update(`file ${rel} ${stat.size}\n`)
      for await (const chunk of createReadStream(full)) hash.update(chunk as Buffer)
    }
  }
  try {
    await add("")
  } catch (error) {
    if (error instanceof InspectError || signal?.aborted === true) throw signal?.reason ?? error
    throw new InspectError(
      `that app can't be read whole (${(error as { code?: string }).code ?? "unreadable"})`,
    )
  }
  return hash.digest("hex")
}

/**
 * The signer of an app at `path`, and whether it's signed at all (an unsigned one has no
 * entitlements to read). Unread: refused (never taken for unsigned).
 */
export async function signerOf(
  path: string,
  signal?: AbortSignal,
): Promise<Signer & { signed: boolean }> {
  const signing = await run("/usr/bin/codesign", ["-dv", path], TIMEOUT)
  const parsed = parseSigning(signing.code, signing.stderr)
  if (parsed.kind === "unread") throw new InspectError("that app's signature couldn't be read")
  if (parsed.kind === "team") return { ...parsed, signed: true }
  return {
    kind: "pinned",
    digest: await codeDigest(path, signal),
    signed: parsed.kind === "adhoc",
  }
}

/**
 * The app at `picked`, inspected (static: nothing of it runs). Refused, said: not an app, where it
 * can't stay, not Electron, an executable that isn't its own file, a Mac App Store build (its own
 * sandbox), a developer signature that doesn't hold.
 */
export async function inspectDesktopApp(picked: string, signal?: AbortSignal): Promise<DesktopApp> {
  let path: string
  try {
    path = await realpath(picked)
    if (!(await lstat(path)).isDirectory()) throw new Error()
  } catch {
    throw new InspectError("that app can't be read (moved or removed?)")
  }
  const place = placeRefusal(path)
  if (place !== undefined) throw new InspectError(place)
  const plist = join(path, "Contents", "Info.plist")
  const bundleId = await plistValue(plist, "CFBundleIdentifier")
  if (bundleId === undefined || !BUNDLE_ID.test(bundleId)) {
    throw new InspectError("that app has no bundle id Kiframe can use")
  }
  const framework = join(path, "Contents/Frameworks/Electron Framework.framework")
  const electron = await plistValue(join(framework, "Resources/Info.plist"), "CFBundleVersion")
  if (electron === undefined) {
    throw new InspectError("that isn't an Electron app: Kiframe drives Electron apps only")
  }
  const exe = await plistValue(plist, "CFBundleExecutable")
  if (exe === undefined || exe === "" || exe === "." || exe === ".." || exe.includes("/")) {
    throw new InspectError("that app names no executable Kiframe can run")
  }
  const executable = join(path, "Contents", "MacOS", exe)
  try {
    const stat = await lstat(executable)
    if (!stat.isFile()) throw new Error()
    if (!(await realpath(executable)).startsWith(`${path}/`)) throw new Error()
    await access(executable, constants.X_OK)
  } catch {
    throw new InspectError("that app's executable isn't its own runnable file")
  }
  const { signed, ...signer } = await signerOf(path, signal)
  // A signed app's entitlements, read (unread: refused, never taken for "not sandboxed"); an
  // unsigned one has none.
  if (signed) {
    const entitlements = await run(
      "/usr/bin/codesign",
      ["-d", "--entitlements", "-", "--xml", path],
      TIMEOUT,
    )
    if (entitlements.code !== 0) {
      throw new InspectError("that app's entitlements couldn't be read")
    }
    if (/<key>com\.apple\.security\.app-sandbox<\/key>\s*<true\s*\/>/.test(entitlements.stdout)) {
      throw new InspectError(
        "that's a Mac App Store build (it has its own sandbox, which can't run in Kiframe's)",
      )
    }
  }
  if (!(await signatureHolds(path, signer))) {
    throw new InspectError("that app's signature is broken: reinstall it")
  }
  const [display, short, version] = await Promise.all(
    ["CFBundleDisplayName", "CFBundleName", "CFBundleShortVersionString"].map((key) =>
      plistValue(plist, key),
    ),
  )
  const name = display ?? short ?? basename(path, ".app")
  return {
    path,
    bundleId,
    name,
    version,
    electron,
    executable,
    signer,
  }
}
