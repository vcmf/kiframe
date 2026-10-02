// A scripted model for the end-to-end tests (unpackaged builds only, chosen by KIFRAME_TEST_MODEL):
// each call answers the file's next turn, then "(done)".
import { readFileSync } from "node:fs"
import type { LlmClient, LlmTurn } from "@kiframe/agent"

export function scriptedModel(file: string): LlmClient {
  const turns = JSON.parse(readFileSync(file, "utf8")) as LlmTurn[]
  let next = 0
  return {
    complete: () => {
      const turn = turns[next] ?? { kind: "text", text: "(done)" }
      next += 1
      return Promise.resolve(turn)
    },
  }
}
