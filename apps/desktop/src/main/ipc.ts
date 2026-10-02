// Main's side of the contract: typed handlers that answer only the app's own page and validate
// every payload, and a typed `emit`.
import { type BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron"
import {
  type Events,
  type InvokeArgs,
  type InvokeChannel,
  invokeArgs,
  type InvokeResults,
} from "../shared/ipc.ts"
import { isAppUrl } from "./security.ts"

export type Handlers = {
  [C in InvokeChannel]: (...args: InvokeArgs<C>) => Promise<InvokeResults[C]> | InvokeResults[C]
}

/** Registers every channel's handler (the type makes it every one). */
export function registerHandlers(handlers: Handlers, devServer?: string): void {
  for (const channel of Object.keys(invokeArgs) as InvokeChannel[]) {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...raw: unknown[]) => {
      // Only the app's own top frame (never a page the window was tricked into loading).
      const frame = event.senderFrame
      if (frame === null || frame.parent !== null || !isAppUrl(frame.url, devServer)) {
        throw new Error("refused: not the app's page")
      }
      const parsed = invokeArgs[channel].safeParse(raw)
      if (!parsed.success) throw new Error(`invalid ${channel}: ${parsed.error.issues[0]?.message}`)
      const handler = handlers[channel] as (...args: unknown[]) => unknown
      return await handler(...(parsed.data as unknown[]))
    })
  }
}

/** Pushes an event to the window (dropped when it's gone). */
export function emit<E extends keyof Events>(
  window: BrowserWindow | null,
  channel: E,
  payload: Events[E],
): void {
  if (window === null || window.isDestroyed() || window.webContents.isDestroyed()) return
  window.webContents.send(channel, payload)
}
