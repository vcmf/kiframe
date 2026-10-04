// Folders inspected off the main thread, each within a time limit: a folder that doesn't answer in
// time (a stuck network mount) is "unknown" (its project's takes kept, never counted gone), and
// the worker it hung is ended (the next folder gets a new one). Electron-free (the worker's maker
// is given: electron-vite's `?nodeWorker` in the app, the folder read in process in tests).
import type { Worker } from "node:worker_threads"
import type { Folder, FolderState } from "./folder-inspect.ts"

export type Inspect = (folder: Folder, projectId: string) => Promise<FolderState>

/** How long a folder may take to read. */
export const FOLDER_TIMEOUT_MS = 5000

export function workerInspector(
  make: () => Worker,
  timeoutMs = FOLDER_TIMEOUT_MS,
): { inspect: Inspect; close: () => void } {
  let worker: Worker | undefined
  let next = 0
  let queue: Promise<unknown> = Promise.resolve()
  const end = () => {
    void worker?.terminate()
    worker = undefined
  }
  const ask = (folder: Folder, projectId: string): Promise<FolderState> =>
    new Promise((resolve) => {
      worker ??= make()
      const w = worker
      const id = ++next
      const done = (state: FolderState) => {
        clearTimeout(timer)
        w.off("message", onMessage)
        w.off("error", onError)
        resolve(state)
      }
      const onMessage = (m: { id: number; state: FolderState }) => {
        if (m.id === id) done(m.state)
      }
      const onError = (error: Error) => {
        end()
        done({ state: "unknown", why: error.message })
      }
      const timer = setTimeout(() => {
        end()
        done({ state: "unknown", why: "it didn't answer in time" })
      }, timeoutMs)
      w.on("message", onMessage)
      w.on("error", onError)
      w.postMessage({ id, folder, projectId })
    })
  return {
    // One folder at a time (a hung one ends its worker before the next is asked).
    inspect: (folder, projectId) => {
      const run = queue.then(() => ask(folder, projectId))
      queue = run.catch(() => undefined)
      return run
    },
    close: end,
  }
}
