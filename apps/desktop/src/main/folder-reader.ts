// Folders inspected off the main thread, each within a time limit: a folder that doesn't answer in
// time (a stuck network mount) is "unknown" (its project's takes kept, never counted gone), and
// the worker it hung is ended. Then every folder is "unknown" for a while, with no new worker (a
// thread stuck in the kernel may never end: at most one left behind per while, never one a folder). Electron-free (the worker's maker
// is given: electron-vite's `?nodeWorker` in the app, the folder read in process in tests).
import type { Worker } from "node:worker_threads"
import type { Folder, FolderState } from "./folder-inspect.ts"

export type Inspect = (folder: Folder, projectId: string) => Promise<FolderState>

/** How long a folder may take to read. */
export const FOLDER_TIMEOUT_MS = 5000

/** After a folder didn't answer: how long no folder is read. */
export const STUCK_FOR_MS = 10 * 60 * 1000

export function workerInspector(
  make: () => Worker,
  timeoutMs = FOLDER_TIMEOUT_MS,
  now = () => Date.now(),
): { inspect: Inspect; close: () => void } {
  let worker: Worker | undefined
  let stuckUntil = 0
  let closed = false
  let next = 0
  let queue: Promise<unknown> = Promise.resolve()
  const end = () => {
    void worker?.terminate()
    worker = undefined
  }
  // Made with listeners for its life: one that ends or fails while idle is dropped (the next
  // folder gets a new one), never asked and waited on.
  const started = (): Worker => {
    const w = make()
    const drop = () => {
      if (worker === w) worker = undefined
    }
    w.on("exit", drop)
    w.on("error", drop)
    return w
  }
  const ask = (folder: Folder, projectId: string): Promise<FolderState> =>
    new Promise((resolve) => {
      if (closed) {
        resolve({ state: "unknown", why: "the app is closing" })
        return
      }
      if (now() < stuckUntil) {
        resolve({ state: "unknown", why: "a folder didn't answer in time a moment ago" })
        return
      }
      // A worker just made starts within its first folder's time (a cold launch: a longer limit).
      const fresh = worker === undefined
      worker ??= started()
      const w = worker
      const id = ++next
      const done = (state: FolderState) => {
        clearTimeout(timer)
        w.off("message", onMessage)
        w.off("error", onError)
        w.off("exit", onExit)
        resolve(state)
      }
      const onMessage = (m: { id: number; state: FolderState }) => {
        if (m.id === id) done(m.state)
      }
      const onError = (error: Error) => {
        end()
        done({ state: "unknown", why: error.message })
      }
      // Ended without an error (terminated at quit, a resource limit): answered now, not stuck.
      const onExit = () => {
        if (worker === w) worker = undefined
        done({ state: "unknown", why: "its reader ended" })
      }
      const timer = setTimeout(
        () => {
          stuckUntil = now() + STUCK_FOR_MS
          end()
          done({ state: "unknown", why: "it didn't answer in time" })
        },
        timeoutMs * (fresh ? 3 : 1),
      )
      w.on("message", onMessage)
      w.on("error", onError)
      w.on("exit", onExit)
      w.postMessage({ id, folder, projectId })
    })
  return {
    // One folder at a time (a hung one ends its worker before the next is asked).
    inspect: (folder, projectId) => {
      const run = queue.then(() => ask(folder, projectId))
      queue = run.catch(() => undefined)
      return run
    },
    close: () => {
      closed = true
      end()
    },
  }
}
