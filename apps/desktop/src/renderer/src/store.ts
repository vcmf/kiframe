// The window's state: main's status (main owns it; the window shows it) and what's busy.
import { create } from "zustand"
import type { AppStatus, InvokeArgs, InvokeChannel, InvokeResults } from "../../shared/ipc.ts"
import { api } from "./api.ts"

type StatusChannel = {
  [C in InvokeChannel]: InvokeResults[C] extends AppStatus ? C : never
}[InvokeChannel]

interface AppState {
  status: AppStatus | null
  /** The action waiting for main (its button shows it), or null. */
  busy: StatusChannel | null
  /** Reads the status and follows main's updates; returns the unsubscribe. */
  connect: () => () => void
  /** Hides the shown error (the next action clears it in main too). */
  dismissError: () => void
  /** Runs an action that answers with the status. */
  run: <C extends StatusChannel>(channel: C, ...args: InvokeArgs<C>) => Promise<void>
}

export const useApp = create<AppState>((set, get) => ({
  status: null,
  busy: null,
  connect: () => {
    const off = api().on("status", (status) => set({ status }))
    api()
      .invoke("app:status")
      .then(
        // Only if nothing newer came first (a push, an action's result).
        (status) => {
          if (get().status === null) set({ status })
        },
        (error: unknown) => {
          if (get().status === null) {
            set({
              status: {
                hasKey: false,
                project: null,
                error: `Kiframe didn’t start: ${String(error)}`,
              },
            })
          }
        },
      )
    return off
  },
  dismissError: () => {
    const now = get().status
    if (now !== null) set({ status: { ...now, error: null } })
  },
  run: async (channel, ...args) => {
    if (get().busy !== null) return
    set({ busy: channel })
    try {
      const status = await api().invoke(channel, ...args)
      set({ status })
    } catch (error) {
      const now = get().status ?? { hasKey: false, project: null, error: null }
      set({ status: { ...now, error: error instanceof Error ? error.message : String(error) } })
    } finally {
      set({ busy: null })
    }
  },
}))
