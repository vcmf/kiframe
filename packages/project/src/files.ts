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
import { open, rename, rm } from "node:fs/promises"
import { dirname, join } from "node:path"

const TMP = /^\.[0-9a-f]{12}\.tmp$/

/**
 * Writes a file whole or not at all: to a temporary sibling (synced to disk), renamed over the
 * target, then the folder synced (a crash or a power loss never leaves a half-written or empty
 * project file).
 */
export function writeAtomic(path: string, content: string): void {
  const folder = dirname(path)
  const created = mkdirSync(folder, { recursive: true })
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
  // A folder made for it: its entry in the parent is synced too (up to the first that existed).
  if (created !== undefined) {
    for (let at = folder; at.length >= created.length; at = dirname(at)) syncFolder(dirname(at))
  }
}

/** As `writeAtomic`, without holding the thread (a take's frames: tens of MB). */
export async function writeAtomicAsync(
  path: string,
  content: Uint8Array,
  mode = 0o600,
): Promise<void> {
  const folder = dirname(path)
  const tmp = join(folder, `.${randomBytes(6).toString("hex")}.tmp`)
  try {
    const file = await open(tmp, "w", mode)
    try {
      await file.writeFile(content)
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true })
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

/** Removes the temporary files an interrupted write left in a folder (its subfolders too, `deep`). */
export function removeStrayTemps(folder: string, deep = false): void {
  if (!existsSync(folder)) return
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    // Only the files our own writes leave (never a folder that happens to match).
    if (entry.isFile() && TMP.test(entry.name)) rmSync(join(folder, entry.name), { force: true })
    else if (deep && entry.isDirectory()) removeStrayTemps(join(folder, entry.name), true)
  }
}

/** Stable JSON: two-space indent and a final newline (diffs and git history stay readable). */
export function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n"
}
