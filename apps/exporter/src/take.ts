import type { TakeInput } from "@kiframe/generators"
import { readTakeRecords } from "@kiframe/project"

/** Reads a take folder written by the recorder (the take store's own reader). */
export function readTake(dir: string): TakeInput {
  return readTakeRecords(dir)
}
