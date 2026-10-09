import type { Viewport } from "@kiframe/schema"
import { ElectronLaunchError, launchElectron } from "./electron.ts"
import type { DesktopApp } from "./electron-inspect.ts"

/**
 * A trial's outcome, read structurally: it runs confined and is driven (`ok`); its window is a site
 * (`site`: a wrapper's, to allow as its own); it quit at once; or it failed (`failed`: said as is).
 */
export type TrialOutcome = { ok: true } | { site: string } | { quit: true } | { failed: string }

export interface TrialOptions {
  /** Sites it shows as its own (a second trial, after the first named one). */
  origins?: readonly string[]
  workDir?: string
  signal?: AbortSignal
  viewport?: Pick<Viewport, "width" | "height" | "deviceScaleFactor">
  timeoutMs?: number
}

/**
 * An app tried before it's added (PR 3b): launched confined, its main window attached, then
 * closed. A stop is thrown as the stop.
 */
export async function trialDesktopApp(
  app: Pick<DesktopApp, "path" | "executable">,
  opts: TrialOptions = {},
): Promise<TrialOutcome> {
  const origins = opts.origins ?? []
  try {
    const target = await launchElectron({
      executable: app.executable,
      bundle: app.path,
      // The network as in a run (its site shown even behind its own offline page): an updater
      // can't touch the real app all the same (nothing outside the sandbox is written).
      network: "all",
      origins,
      viewport: opts.viewport ?? { width: 1440, height: 900, deviceScaleFactor: 1 },
      ...(opts.workDir !== undefined && { workDir: opts.workDir }),
      ...(opts.signal !== undefined && { signal: opts.signal }),
      ...(opts.timeoutMs !== undefined && { timeoutMs: opts.timeoutMs }),
    })
    await target.close()
    return { ok: true }
  } catch (error) {
    if (opts.signal?.aborted === true) throw opts.signal.reason
    // Anything else is Kiframe's own fault: thrown, never shown as the app's.
    if (!(error instanceof ElectronLaunchError)) throw error
    if (error.why === "site" && error.site !== undefined) return { site: error.site }
    if (error.why === "quit") return { quit: true }
    return { failed: error.message }
  }
}
