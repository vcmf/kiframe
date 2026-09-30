import { randomBytes } from "node:crypto"
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

/**
 * Writes a file whole or not at all: to a temporary sibling, then renamed over the target (a crash
 * mid-write never leaves a half-written project file).
 */
export function writeAtomic(path: string, content: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.${randomBytes(6).toString("hex")}.tmp`)
  try {
    writeFileSync(tmp, content, mode === undefined ? undefined : { mode })
    renameSync(tmp, path)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}

/** Stable JSON: two-space indent and a final newline (diffs and git history stay readable). */
export function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n"
}
