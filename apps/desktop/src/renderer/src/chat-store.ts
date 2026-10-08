// The open project's chat, as main folds it (main owns it; the window shows it and sends the
// user's messages, stops and answers), and the live app's latest frame.
import { create } from "zustand"
import {
  ATTACHABLE,
  ATTACHMENT_BYTES,
  type AttachedFile,
  type ChatAnswer,
  type ChatItem,
  type LiveFrame,
  MAX_ATTACHMENTS,
} from "../../shared/ipc.ts"
import { errorMessage, upsert } from "../../shared/util.ts"

import { api } from "./api.ts"

interface ChatStore {
  items: ChatItem[]
  running: boolean
  model: string
  frame: LiveFrame | null
  /** Why the last message didn't start a run (said under the composer). */
  refused: string | null
  /** Files the user attached to the message being written (sent with it, then cleared). */
  pending: File[]
  /** Files added (picked, dropped, pasted): beyond the 5 a message takes, refused (said). */
  attach: (files: readonly File[]) => void
  detach: (index: number) => void
  /** Loads the open project's chat and follows main's updates; returns the unsubscribe. */
  connect: () => () => void
  /** Sends the text with the pending files (cleared once the run started). */
  send: (text: string) => Promise<boolean>
  stop: () => void
  answer: (id: string, answer: ChatAnswer) => void
}

/** The connect current (a late answer to an earlier one is dropped). */
let generation = 0

/** A pasted image's extension, by its type. */
const PASTED: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
}

/**
 * A pasted image under a name of its own (the clipboard calls each one image.png): the time it was
 * pasted, so a hundred screenshots never queue for the same name.
 */
export function pastedFile(file: File, at = new Date()): File {
  const ext = Object.hasOwn(PASTED, file.type) ? PASTED[file.type] : "png"
  const stamp = at.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)
  return new File([file], `pasted-${stamp}-${Math.floor(Math.random() * 1000)}.${ext}`, {
    type: file.type,
  })
}

/** Why a file can't be attached, seen before its bytes are read (main checks it again). */
function notAttachable(file: File): string | undefined {
  const ext = file.name.includes(".") ? file.name.slice(file.name.lastIndexOf(".") + 1) : ""
  if (!ATTACHABLE.includes(ext.toLowerCase())) {
    return `${file.name}: attach images (PNG, JPEG, GIF, WebP), SVG, text (.md, .txt) or HTML`
  }
  if (file.size > ATTACHMENT_BYTES) return `${file.name} is over 10 MB`
  return undefined
}

/** A file's bytes for main (a fresh array of its own: never a view of a larger buffer). */
async function attached(file: File): Promise<AttachedFile> {
  return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }
}

export const useChat = create<ChatStore>((set, get) => ({
  items: [],
  running: false,
  model: "",
  frame: null,
  refused: null,
  pending: [],
  attach: (files) =>
    set((s) => {
      const refused = files.map(notAttachable).find((r) => r !== undefined)
      if (refused !== undefined) return { refused }
      const all = [...s.pending, ...files]
      return all.length > MAX_ATTACHMENTS
        ? { refused: `at most ${MAX_ATTACHMENTS} files a message` }
        : { pending: all, refused: null }
    }),
  detach: (index) => set((s) => ({ pending: s.pending.filter((_, i) => i !== index) })),
  connect: () => {
    set({ items: [], running: false, frame: null, refused: null, pending: [] })
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
      const files = get().pending
      const refused =
        files.length === 0
          ? await api().invoke("chat:send", text)
          : await api().invoke("chat:send", text, await Promise.all(files.map(attached)))
      // Only the files sent are cleared (one added meanwhile stays for the next message).
      set((s) =>
        refused === null
          ? { refused, pending: s.pending.filter((f) => !files.includes(f)) }
          : { refused },
      )
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
