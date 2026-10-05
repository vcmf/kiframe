// A scripted model for the end-to-end tests (unpackaged builds only, chosen by KIFRAME_TEST_MODEL):
// each call answers the file's next turn, then "(done)". A turn with `think` (ms) streams that
// long a stretch of thinking first.
import { readFileSync } from "node:fs"
import type { LlmClient, LlmStreamEvent, LlmTurn } from "@kiframe/agent"

type ScriptedTurn = LlmTurn & { think?: number }

export function scriptedModel(file: string): LlmClient {
  const turns = JSON.parse(readFileSync(file, "utf8")) as ScriptedTurn[]
  let next = 0
  const take = (): ScriptedTurn => {
    const turn = turns[next] ?? { kind: "text", text: "(done)" }
    next += 1
    return turn
  }
  return {
    complete: () => {
      const { think: _think, ...turn } = take()
      return Promise.resolve(turn)
    },
    async *completeStream(_messages, _tools, signal): AsyncIterable<LlmStreamEvent> {
      const { think = 0, ...turn } = take()
      const end = Date.now() + think
      while (Date.now() < end && signal?.aborted !== true) {
        yield { kind: "reasoning", text: "…" }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      yield { kind: "final", turn }
    },
  }
}
