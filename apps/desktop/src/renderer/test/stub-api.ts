// A stand-in for the preload's `window.kiframe`, typed by the contract: each test answers the
// channels it needs and pushes events.
import { vi } from "vitest"
import type {
  AppStatus,
  Events,
  InvokeChannel,
  InvokeResults,
  KiframeApi,
} from "../../shared/ipc.ts"

export const status = (over: Partial<AppStatus> = {}): AppStatus => ({
  hasKey: false,
  project: null,
  error: null,
  ...over,
})

export function stubApi(
  answers: Partial<{ [C in InvokeChannel]: (...args: unknown[]) => InvokeResults[C] }>,
) {
  const listeners = new Map<string, Set<(payload: never) => void>>()
  // The chat's state by default: empty, idle (a test answers it to show more).
  const defaults: Partial<Record<InvokeChannel, (...args: unknown[]) => unknown>> = {
    "chat:state": () => ({ items: [], running: false, model: "test/model" }),
  }
  const invoke = vi.fn((channel: InvokeChannel, ...args: unknown[]) => {
    const answer = (answers[channel] ?? defaults[channel]) as
      ((...a: unknown[]) => unknown) | undefined
    if (answer === undefined) return Promise.reject(new Error(`no answer for ${channel}`))
    return Promise.resolve(answer(...args))
  })
  const api: KiframeApi = {
    invoke: invoke as unknown as KiframeApi["invoke"],
    on: (channel, listener) => {
      const set = listeners.get(channel) ?? new Set()
      set.add(listener)
      listeners.set(channel, set)
      return () => set.delete(listener)
    },
    platform: "darwin",
  }
  window.kiframe = api
  const push = <E extends keyof Events>(channel: E, payload: Events[E]) => {
    for (const l of listeners.get(channel) ?? []) (l as (p: Events[E]) => void)(payload)
  }
  return { invoke, push }
}
