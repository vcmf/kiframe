// The window's only door to main (sandboxed: Electron's contextBridge and ipcRenderer, nothing
// else). Only the contract's channels pass; payloads are validated again in main.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron"
import { EVENT_CHANNELS, INVOKE_CHANNELS } from "../shared/channels.ts"
import type { KiframeApi } from "../shared/ipc.ts"

const invokes = new Set<string>(INVOKE_CHANNELS)
const events = new Set<string>(EVENT_CHANNELS)

const api = {
  invoke: (channel, ...args) => {
    if (!invokes.has(channel)) return Promise.reject(new Error(`unknown channel ${channel}`))
    return ipcRenderer.invoke(channel, ...args) as Promise<never>
  },
  on: (channel, listener) => {
    if (!events.has(channel)) throw new Error(`unknown event ${channel}`)
    const wrapped = (_event: IpcRendererEvent, payload: unknown) =>
      listener(payload as Parameters<typeof listener>[0])
    ipcRenderer.on(channel, wrapped)
    return () => {
      ipcRenderer.removeListener(channel, wrapped)
    }
  },
  platform: process.platform,
} satisfies KiframeApi

contextBridge.exposeInMainWorld("kiframe", api)
