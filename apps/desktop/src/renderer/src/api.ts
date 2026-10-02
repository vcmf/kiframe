// The window's one seam to main: the preload's `window.kiframe`, typed by the contract.
import type { KiframeApi } from "../../shared/ipc.ts"

declare global {
  interface Window {
    kiframe: KiframeApi
  }
}

export const api = (): KiframeApi => window.kiframe
