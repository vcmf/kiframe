// A take's records as the compositor reads them, apart from the store (no runtime: the exporter
// reads a take with it alone).
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { CursorSample, TakeEvent, TakeMeta } from "@kiframe/schema"
import { type KeySource, readTakeFile, readTakeFileAsync } from "./take-crypt.ts"

/** The newest take format this Kiframe reads (a newer one is refused, never skipped as not a take). */
export const TAKE_VERSION = 1

/** Why a take's meta (parsed) can't be read by this Kiframe: one a newer Kiframe wrote. */
export function newerTake(raw: unknown, dir: string): Error | undefined {
  const version = (raw as { version?: unknown } | null)?.version
  if (typeof version === "number" && version > TAKE_VERSION) {
    return new Error(
      `${dir}: recorded by a newer Kiframe (take version ${version}): update Kiframe`,
    )
  }
  return undefined
}

/** A take's records (validated: a take is data from disk). */
export interface TakeRecords {
  meta: TakeMeta
  events: TakeEvent[]
  cursor: CursorSample[]
}

/**
 * Reads a take folder's records (meta.json, events.jsonl, cursor.jsonl), each refusal in its own
 * words: a newer Kiframe's take, a field that doesn't validate (a take from before secret regions
 * had spans: re-record it), an encrypted take without its key.
 */
export function readTakeRecords(dir: string, key?: Uint8Array, sealed = false): TakeRecords {
  const raw = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as unknown
  const newer = newerTake(raw, dir)
  if (newer !== undefined) throw newer
  // Decrypted when the store encrypted them (a key needed: else said so).
  const lines = (file: string) =>
    readTakeFile(join(dir, file), key, sealed)
      .toString("utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as unknown)
  return {
    meta: TakeMeta.parse(raw),
    events: lines("events.jsonl").map((e) => TakeEvent.parse(e)),
    cursor: lines("cursor.jsonl").map((c) => CursorSample.parse(c)),
  }
}

/** As `readTakeRecords`, read without holding the thread, the key asked only if a file is encrypted. */
export async function readTakeRecordsAsync(
  dir: string,
  key: KeySource,
  sealed = false,
): Promise<TakeRecords> {
  const raw = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as unknown
  const newer = newerTake(raw, dir)
  if (newer !== undefined) throw newer
  const lines = async (file: string) =>
    (await readTakeFileAsync(join(dir, file), key, sealed))
      .toString("utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as unknown)
  return {
    meta: TakeMeta.parse(raw),
    events: (await lines("events.jsonl")).map((e) => TakeEvent.parse(e)),
    cursor: (await lines("cursor.jsonl")).map((c) => CursorSample.parse(c)),
  }
}
