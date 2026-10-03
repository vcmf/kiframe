// The open project's chat, as main folds it (main owns it; the window shows it and sends the
// user's messages, stops and answers), and the live app's latest frame.
import { create } from "zustand"
import type { ChatItem, LiveFrame } from "../../shared/ipc.ts"
import { errorMessage, upsert } from "../../shared/util.ts"

import { api } from "./api.ts"

interface ChatStore {
  items: ChatItem[]
  running: boolean
  model: string
  frame: LiveFrame | null
  /** Why the last message didn't start a run (said under the composer). */
  refused: string | null
  /** Loads the open project's chat and follows main's updates; returns the unsubscribe. */
  connect: () => () => void
  send: (text: string) => Promise<boolean>
  stop: () => void
  answer: (id: string, answer: string | boolean) => void
}

/** The connect current (a late answer to an earlier one is dropped). */
let generation = 0

export const useChat = create<ChatStore>((set) => ({
  items: [],
  running: false,
  model: "",
  frame: null,
  refused: null,
  connect: () => {
    set({ items: [], running: false, frame: null, refused: null })
    const offs = [
      api().on("chat:item", (item) => set((s) => ({ items: upsert(s.items, item) }))),
      api().on("chat:running", (running) => set({ running })),
      api().on("live:frame", (frame) => set({ frame })),
    ]
    // Main answers after every event it sent before: its state is the whole truth then (later
    // events come after it). Only for the connect still current.
    const at = (generation += 1)
    void api()
      .invoke("chat:state")
      .then((state) => {
        if (at !== generation) return
        set({ items: state.items, running: state.running, model: state.model, frame: state.frame })
      })
      .catch(() => undefined)
    return () => {
      for (const off of offs) off()
    }
  },
  send: async (text) => {
    try {
      const refused = await api().invoke("chat:send", text)
      set({ refused })
      return refused === null
    } catch (error) {
      set({ refused: errorMessage(error) })
      return false
    }
  },
  stop: () => {
    void api()
      .invoke("chat:stop")
      .catch(() => undefined)
  },
  answer: (id, answer) => {
    void api()
      .invoke("chat:answer", id, answer)
      .catch(() => undefined)
  },
}))
