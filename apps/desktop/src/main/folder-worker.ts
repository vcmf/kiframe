// The worker thread folders are read in (folder-reader.ts): one request at a time, answered by id.
import { parentPort } from "node:worker_threads"
import { type Folder, inspectFolder } from "./folder-inspect.ts"

parentPort?.on("message", (request: { id: number; folder: Folder; projectId: string }) => {
  let state
  try {
    state = inspectFolder(request.folder, request.projectId)
  } catch (error) {
    state = { state: "unknown", why: error instanceof Error ? error.message : String(error) }
  }
  parentPort?.postMessage({ id: request.id, state })
})
