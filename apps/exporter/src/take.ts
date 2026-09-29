import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { TakeInput } from "@kiframe/generators"
import { CursorSample, TakeEvent, TakeMeta } from "@kiframe/schema"

/** Reads a take folder written by the recorder (validated: a take is data from disk). */
export function readTake(dir: string): TakeInput {
  const lines = (file: string) =>
    readFileSync(join(dir, file), "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as unknown)
  return {
    // A take from before secret regions had spans fails validation: re-record it.
    meta: TakeMeta.parse(JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"))),
    events: lines("events.jsonl").map((e) => TakeEvent.parse(e)),
    cursor: lines("cursor.jsonl").map((c) => CursorSample.parse(c)),
  }
}
