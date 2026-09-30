import { randomBytes } from "node:crypto"
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"

const TMP = /^\.[0-9a-f]{12}\.tmp$/

/**
 * Writes a file whole or not at all: to a temporary sibling (synced to disk), renamed over the
 * target, then the folder synced (a crash or a power loss never leaves a half-written or empty
 * project file).
 */
export function writeAtomic(path: string, content: string): void {
  const folder = dirname(path)
  mkdirSync(folder, { recursive: true })
  const tmp = join(folder, `.${randomBytes(6).toString("hex")}.tmp`)
  try {
    const fd = openSync(tmp, "w")
    try {
      // (writeFileSync on a descriptor loops until every byte is written: no short write.)
      writeFileSync(fd, content)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, path)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
  syncFolder(folder)
}

function syncFolder(folder: string): void {
  try {
    const fd = openSync(folder, "r")
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch {
    // not supported everywhere (Windows): the file itself is synced
  }
}

/** Removes the temporary files an interrupted write left in a folder. */
export function removeStrayTemps(folder: string): void {
  if (!existsSync(folder)) return
  for (const name of readdirSync(folder)) {
    if (TMP.test(name)) rmSync(join(folder, name), { force: true })
  }
}

/** Stable JSON: two-space indent and a final newline (diffs and git history stay readable). */
export function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n"
}
