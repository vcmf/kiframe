import { execFile } from "node:child_process"
import { constants, existsSync, rmSync, writeFileSync } from "node:fs"
import { copyFile, lstat, mkdir, readdir, utimes } from "node:fs/promises"
import { join } from "node:path"
import { filesPath } from "@kiframe/schema"

// A desktop app's launch confined by macOS's Seatbelt (`sandbox-exec`; measured on a fixture app,
// 2026-10-09: every escape below refused, the app driven as usual). Its own sandbox is the only
// place it writes; it never reads the user's folders, never starts a program outside the
// confinement (LaunchServices, AppleScript, launchd), never reaches the user's preferences or
// keychain (a mock keychain instead), never connects to the user's agents' sockets. Chromium's own
// sandbox can't nest in it (turned off: the guard and this profile replace it).

/** Where the confinement lives (macOS); absent: desktop apps can't be launched (never unconfined). */
export const SANDBOX_EXEC = "/usr/bin/sandbox-exec"

/** Kiframe's own switches to an app run under the profile (after the project's arguments). */
export const CONFINED_SWITCHES = ["--no-sandbox", "--use-mock-keychain"]

export interface Confinement {
  /** The launch's sandbox (real path): the only place written, read in full. */
  sandbox: string
  /** What the app reads besides: its bundle (real paths). */
  readable: readonly string[]
  /**
   * The user's own folders, never read (real paths: the home and Kiframe's work area), wherever
   * they are (a home outside /Users on a managed Mac).
   */
  private: readonly string[]
  /** "all": the app's backend reachable (a run); "loopback": nothing beyond this machine (a trial). */
  network: "all" | "loopback"
}

/** A string in the profile's language (quoted, its backslashes and quotes escaped). */
const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`

/** The Seatbelt profile of a launch. Later rules win over earlier ones. */
export function seatbeltProfile(c: Confinement): string {
  const readable = [c.sandbox, ...c.readable].map((p) => `(subpath ${q(p)})`).join(" ")
  return `(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath ${q(c.sandbox)}) (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (regex #"^/dev/tty") (regex #"^/dev/fd/"))
(deny file-read-data (subpath "/Users") (subpath "/Volumes") (subpath "/private/var/folders") (subpath "/private/tmp") (subpath "/var/folders") (subpath "/tmp")${c.private.map((p) => ` (subpath ${q(p)})`).join("")})
(allow file-read-data ${readable})
(deny network-outbound (remote unix-socket))
(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))
(deny appleevent-send)
(deny process-exec* (subpath ${q(c.sandbox)}) (literal "/usr/bin/open") (literal "/usr/bin/osascript") (literal "/bin/launchctl"))
(deny mach-lookup (global-name "com.apple.cfprefsd.agent") (global-name "com.apple.SecurityServer") (global-name "com.apple.pasteboard.1"))
${c.network === "loopback" ? '(deny network-outbound)\n(allow network-outbound (remote ip "localhost:*"))\n(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))' : ""}
`
}

/** A confinement that can't be used: said, and no desktop app is launched (never unconfined). */
export class ConfinementError extends Error {}

/** Whether a program confined by `c` reads `file` (its content, exactly). */
function readsUnder(c: Confinement, file: string, content: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      SANDBOX_EXEC,
      ["-p", seatbeltProfile(c), "/bin/cat", file],
      { timeout: 5000 },
      (error, stdout) => resolve(error === null && stdout === content),
    )
  })
}

/**
 * Before each launch: the confinement still holds (a canary: a file the profile denies isn't
 * read, while one in the sandbox is: a confinement that runs nothing never passes for one that
 * refuses). Missing or broken (a macOS that removed or changed it): refused.
 */
export async function checkConfinement(c: Confinement, denied: string): Promise<void> {
  if (!existsSync(SANDBOX_EXEC)) {
    throw new ConfinementError(
      "macOS's sandbox-exec is missing: Kiframe can't confine desktop apps",
    )
  }
  const allowed = join(c.sandbox, "canary.txt")
  let deniedRead: boolean
  let allowedRead: boolean
  try {
    writeFileSync(denied, "canary")
    writeFileSync(allowed, "canary")
    ;[deniedRead, allowedRead] = await Promise.all([
      readsUnder(c, denied, "canary"),
      readsUnder(c, allowed, "canary"),
    ])
  } catch (error) {
    throw new ConfinementError(
      `the confinement couldn't be checked (${(error as { code?: string }).code ?? String(error)})`,
    )
  } finally {
    rmSync(allowed, { force: true })
    rmSync(denied, { force: true })
  }
  if (deniedRead) {
    throw new ConfinementError(
      "the confinement didn't hold (a canary was read): desktop apps are off",
    )
  }
  if (!allowedRead) {
    throw new ConfinementError(
      "the confinement doesn't run programs (its own sandbox unread): desktop apps are off",
    )
  }
}

/** A project's files/ too large to copy at each launch, or holding what can't be copied safely. */
export class FilesError extends Error {}

/** The copy's limits (it's made at every launch). */
export const FILES_LIMITS = { bytes: 500 * 1024 * 1024, files: 20_000, depth: 32 }

/**
 * A project's `files/` copied into a launch's sandbox (what the app opens: every run from the same
 * files, its edits thrown away). Own walk, never a library copy: only folders and regular files
 * (a link, a FIFO, a socket, a device refused: never followed, never opened), within the limits;
 * cloned where the disk can (APFS: near instant), times kept (a run sees the files as they are).
 */
export async function copyFiles(from: string, to: string): Promise<void> {
  let bytes = 0
  let entries = 0
  const tooLarge = () =>
    new FilesError("files/ is too large to copy at each launch (500 MB, 20,000 entries)")
  const walk = async (src: string, dst: string, depth: number, rel: string): Promise<void> => {
    if (depth > FILES_LIMITS.depth) throw new FilesError(`files/${rel} is nested too deep`)
    await mkdir(dst, { recursive: true })
    for (const name of await readdir(src)) {
      const s = join(src, name)
      const d = join(dst, name)
      const r = rel === "" ? name : `${rel}/${name}`
      const stat = await lstat(s)
      // Folders count too (a tree of empty ones is as slow to copy and remove).
      entries += 1
      if (entries > FILES_LIMITS.files) throw tooLarge()
      if (stat.isDirectory()) {
        await walk(s, d, depth + 1, r)
      } else if (stat.isFile()) {
        bytes += stat.size
        if (bytes > FILES_LIMITS.bytes) throw tooLarge()
        await copyFile(s, d, constants.COPYFILE_FICLONE)
        // copyFile follows a link: an entry swapped for one meanwhile is refused (still the file
        // that was checked, never what a link points at).
        const after = await lstat(s)
        if (!after.isFile() || after.ino !== stat.ino || after.dev !== stat.dev) {
          throw new FilesError(`files/${r} changed while it was copied: try again`)
        }
        await utimes(d, stat.atime, stat.mtime)
      } else {
        throw new FilesError(`files/${r} isn't a file or a folder (a link?): only those are copied`)
      }
    }
  }
  try {
    // files/ itself a real folder (a shared project's files/ linked to the user's documents: never
    // followed).
    const root = await lstat(from)
    if (!root.isDirectory()) {
      throw new FilesError(
        "the project's files/ isn't a folder (a link?): only a real one is copied",
      )
    }
    await walk(from, to, 0, "")
  } catch (error) {
    if (error instanceof FilesError) throw error
    const code = (error as { code?: string }).code
    throw new FilesError(
      code === "ENOENT" && !existsSync(from)
        ? "the project has no files/ folder (what its arguments name)"
        : `files/ couldn't be copied (${code ?? String(error)})`,
    )
  }
}

/**
 * A launch argument (the project's `files/<path>`) as the app gets it: the copy's absolute path in
 * the sandbox. Anything else refused (the schema allows nothing else).
 */
export function argumentIn(arg: string, filesCopy: string): string {
  const parts = filesPath(arg)
  if (parts === undefined) {
    throw new FilesError(`"${arg}": a desktop app opens only what's in the project's files/`)
  }
  return join(filesCopy, ...parts)
}
