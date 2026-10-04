// A take's records as the compositor reads them, apart from the store (no runtime: the exporter
// reads a take with it alone).
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { CursorSample, TakeEvent, TakeMeta } from "@kiframe/schema"
import { isEncrypted, readTakeFileAsync, type TakeFileReading } from "./take-crypt.ts"

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

/** A take's records from its files' text (validated: a take is data from disk). */
function parseRecords(meta: TakeMeta, events: string, cursor: string): TakeRecords {
  const lines = (text: string) =>
    text
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as unknown)
  return {
    meta,
    events: lines(events).map((e) => TakeEvent.parse(e)),
    cursor: lines(cursor).map((c) => CursorSample.parse(c)),
  }
}

/** A take's meta.json, each refusal in its own words (a newer Kiframe's take, a field). */
export function readTakeMeta(dir: string): TakeMeta {
  const raw = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as unknown
  const newer = newerTake(raw, dir)
  if (newer !== undefined) throw newer
  return TakeMeta.parse(raw)
}

/**
 * Reads a plain take folder's records (meta.json, events.jsonl, cursor.jsonl: the exporter's takes),
 * each refusal in its own words: a newer Kiframe's take, a field that doesn't validate (a take
 * from before secret regions had spans: re-record it), an encrypted take (the app reads those).
 */
export function readTakeRecords(dir: string): TakeRecords {
  const text = (file: string) => {
    const bytes = readFileSync(join(dir, file))
    if (isEncrypted(bytes)) throw new Error("the take is encrypted: export it from the app")
    return bytes.toString("utf8")
  }
  return parseRecords(readTakeMeta(dir), text("events.jsonl"), text("cursor.jsonl"))
}

/** A take's records, its meta as read, its files decrypted when encrypted (bound to the take). */
export async function readTakeRecordsAsync(
  dir: string,
  meta: TakeMeta,
  reading: Omit<TakeFileReading, "bound">,
): Promise<TakeRecords> {
  const text = async (file: string) =>
    (
      await readTakeFileAsync(join(dir, file), { ...reading, bound: `${meta.takeKey}/${file}` })
    ).toString("utf8")
  const [events, cursor] = await Promise.all([text("events.jsonl"), text("cursor.jsonl")])
  return parseRecords(meta, events, cursor)
}
