// A take's records as the compositor reads them, apart from the store (no runtime: the exporter
// reads a take with it alone).
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { CursorSample, TakeEvent, TakeMeta } from "@kiframe/schema"

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
 * had spans: re-record it).
 */
export function readTakeRecords(dir: string): TakeRecords {
  const raw = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as unknown
  const newer = newerTake(raw, dir)
  if (newer !== undefined) throw newer
  const lines = (file: string) =>
    readFileSync(join(dir, file), "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as unknown)
  return {
    meta: TakeMeta.parse(raw),
    events: lines("events.jsonl").map((e) => TakeEvent.parse(e)),
    cursor: lines("cursor.jsonl").map((c) => CursorSample.parse(c)),
  }
}
