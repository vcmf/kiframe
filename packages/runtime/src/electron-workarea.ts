import { execFile } from "node:child_process"
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs"
import { readdir, readlink, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"

// Kiframe's work area for desktop apps (decided by the user 2026-10-09): `~/.kiframe/`, safe to
// delete at any time. Each launch's sandbox is a folder in `sandboxes/` whose name says which
// Kiframe made it (`kiframe-app-<pid>-<started>-…`: owned from the moment it exists, no state file
// to race on), so what a crash left is swept at the next start, never another running Kiframe's (a
// dev and a release build share the folder).

/** The default work area. */
export function defaultWorkDir(): string {
  return join(homedir(), ".kiframe")
}

/** A work area that can't be used (a link, another user's, not a folder): said as is. */
export class WorkAreaError extends Error {}

const prepared = new Set<string>()

/**
 * `work`/sandboxes made (or checked): real folders (never links), this user's, readable by them
 * alone (0700); the work area kept out of backups and Spotlight (once per process). Returns the
 * sandboxes folder's real path.
 */
export function sandboxesOf(work: string): string {
  const sandboxes = join(work, "sandboxes")
  for (const dir of [work, sandboxes]) {
    let stat
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      stat = lstatSync(dir)
    } catch (error) {
      throw new WorkAreaError(
        `${dir} can't be made (${(error as { code?: string }).code ?? String(error)})`,
      )
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new WorkAreaError(`${dir} isn't a folder (a link?): Kiframe uses only a real one`)
    }
    if (process.getuid !== undefined && stat.uid !== process.getuid()) {
      throw new WorkAreaError(`${dir} belongs to another user`)
    }
    if ((stat.mode & 0o777) !== 0o700) chmodSync(dir, 0o700)
  }
  if (!prepared.has(work)) {
    prepared.add(work)
    // Never indexed nor backed up (an app's throwaway data). Best effort: said by no one.
    try {
      writeFileSync(join(work, ".metadata_never_index"), "")
    } catch {
      // read-only? the launch says it next
    }
    if (process.platform === "darwin") {
      execFile("tmutil", ["addexclusion", work], () => undefined)
    }
  }
  return realpathSync(sandboxes)
}

/**
 * A new sandbox folder, owned by this process from the moment it exists (its name says so). Its
 * real path (a file: page's path is compared with it).
 */
export async function newSandbox(work: string): Promise<string> {
  const sandboxes = sandboxesOf(work)
  const owner = await self()
  return realpathSync(mkdtempSync(join(sandboxes, `${PREFIX}${owner.pid}-${owner.started}-`)))
}

const PREFIX = "kiframe-app-"

/** A sandbox folder this module makes: `kiframe-app-*` directly in the work area's sandboxes. */
export function isSandbox(path: string, work: string): boolean {
  try {
    const real = realpathSync(path)
    return (
      dirname(real) === realpathSync(join(work, "sandboxes")) &&
      basename(real).startsWith(PREFIX) &&
      !lstatSync(path).isSymbolicLink()
    )
  } catch {
    return false
  }
}

/** Who started a launch: a Kiframe process, by its id and when it started (ids are reused). */
interface Owner {
  pid: number
  started: number
}

/** A sandbox's owner, from its name (none: an older or foreign name, owned by no one). */
function ownerOf(name: string): Owner | undefined {
  const match = /^kiframe-app-(\d+)-(\d+)-/.exec(name)
  return match === null ? undefined : { pid: Number(match[1]), started: Number(match[2]) }
}

/** A command's output (undefined when it fails; lsof's "nothing found" is an answer). */
export async function run(cmd: string, args: string[]): Promise<string | undefined> {
  const out = await command(cmd, args, 5000)
  return out.code === 0 || out.code === 1 ? out.stdout : undefined
}

/**
 * A command's exit code (-1: it couldn't run, or timed out) and output, in the C locale: what's
 * parsed (a start time, codesign's fields) reads the same in every language.
 */
export function command(
  cmd: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, LC_ALL: "C" },
        ...(signal !== undefined && { signal }),
      },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : -1
        resolve({ code: error?.killed === true ? -1 : code, stdout, stderr })
      },
    )
  })
}

/**
 * When a process started, in seconds, from `ps`: undefined when it isn't running, null when `ps`
 * can't be read (nothing can be said of any owner).
 */
async function startOf(pid: number): Promise<number | undefined | null> {
  const out = await run("ps", ["-o", "lstart=", "-p", String(pid)])
  if (out === undefined) return null
  const at = Date.parse(out.trim())
  return Number.isNaN(at) ? undefined : Math.round(at / 1000)
}

let me: Promise<Owner> | undefined
/** This process as an owner. */
function self(): Promise<Owner> {
  me ??= startOf(process.pid).then((started) => ({
    pid: process.pid,
    started: started ?? Math.round(Date.now() / 1000 - process.uptime()),
  }))
  return me
}

/**
 * Whether an owner still runs: its id alive and started when it was noted (never a reused id, this
 * process's own included: a note from before a reboot can carry it). Null when `ps` can't say.
 */
async function alive(owner: Owner): Promise<boolean | null> {
  const mine = await self()
  if (owner.pid === mine.pid) return owner.started === mine.started
  const started = await startOf(owner.pid)
  if (started === null) return null
  return started !== undefined && Math.abs(started - owner.started) <= 2
}

/**
 * Every process's working folder: Linux's /proc (quick), else `lsof` (macOS: no /proc); undefined
 * when it can't be read.
 */
async function workingDirs(): Promise<[number, string][] | undefined> {
  if (process.platform === "linux") {
    const out: [number, string][] = []
    try {
      for (const entry of await readdir("/proc")) {
        if (!/^\d+$/.test(entry)) continue
        try {
          out.push([Number(entry), await readlink(`/proc/${entry}/cwd`)])
        } catch {
          // gone, or another user's
        }
      }
      return out
    } catch {
      return undefined
    }
  }
  const listed = await run("lsof", ["-a", "-d", "cwd", "-Fpn"])
  if (listed === undefined) return undefined
  const out: [number, string][] = []
  let pid: number | undefined
  for (const line of listed.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1))
    else if (line.startsWith("n") && pid !== undefined) out.push([pid, line.slice(1)])
  }
  return out
}

/**
 * Kills every process (never this one) that points at `under`: its command line names it (an
 * app's helpers carry `--user-data-dir=<sandbox>/profile`), or it works in it (a helper detached
 * with its cwd there); and the groups of the app's own processes (those with its profile: what
 * stays in the group after a crash, pointing nowhere). Unread: said.
 */
export async function sweepProcesses(
  unders: string | readonly string[],
): Promise<{ swept: number; unread: boolean }> {
  const all = typeof unders === "string" ? [unders] : unders
  if (all.length === 0) return { swept: 0, unread: false }
  const [ps, cwds] = await Promise.all([run("ps", ["-axo", "pid=,pgid=,command="]), workingDirs()])
  const table: { pid: number; pgid: number; command: string }[] = []
  for (const line of ps?.split("\n") ?? []) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (match !== null) {
      table.push({ pid: Number(match[1]), pgid: Number(match[2]), command: match[3] ?? "" })
    }
  }
  const pids = new Set<number>()
  const groups = new Set<number>()
  const within = (path: string) =>
    all.some((under) => path === under || path.startsWith(`${under}/`))
  for (const p of table) {
    if (!all.some((under) => p.command.includes(under))) continue
    pids.add(p.pid)
    if (all.some((under) => p.command.includes(`--user-data-dir=${under}/`))) groups.add(p.pgid)
  }
  for (const [pid, cwd] of cwds ?? []) if (within(cwd)) pids.add(pid)
  // Never this process's own group.
  const own = table.find((p) => p.pid === process.pid)?.pgid
  if (own !== undefined) groups.delete(own)
  for (const p of table) if (groups.has(p.pgid)) pids.add(p.pid)
  pids.delete(process.pid)
  for (const p of pids) {
    try {
      process.kill(p, "SIGKILL")
    } catch {
      // gone
    }
  }
  return { swept: pids.size, unread: ps === undefined || cwds === undefined }
}

/**
 * At the host's start: every sandbox in the work area that no running Kiframe owns (a crash left
 * it) has the processes pointing at it killed and is removed. Another running Kiframe's launches
 * are left alone; when `ps` can't be read nothing is swept (an owner can't be told dead). Only this
 * module's sandboxes are ever touched.
 */
export async function sweepWorkArea(work: string): Promise<number> {
  if (!existsSync(join(work, "sandboxes"))) return 0
  const sandboxes = sandboxesOf(work)
  if ((await startOf(process.pid)) === null) return 0
  const dead: string[] = []
  for (const name of readdirSync(sandboxes)) {
    const path = join(sandboxes, name)
    if (!isSandbox(path, work)) continue
    const owner = ownerOf(name)
    const live = owner === undefined ? false : await alive(owner)
    // ps unreadable meanwhile: nothing said dead.
    if (live === null) return 0
    if (!live) dead.push(realpathOr(path))
  }
  // One read of the processes for all of them (lsof is slow).
  await sweepProcesses(dead)
  for (const path of dead) {
    await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      () => undefined,
    )
  }
  return dead.length
}

/** A path's real path, or the path itself when it can't be resolved (gone). */
export function realpathOr(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}
