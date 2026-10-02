// Kiframe's main process: one instance, the hardened window, and the handlers of the contract.
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { TakeStore } from "@kiframe/project"
import { keychainBackend, memoryBackend } from "@kiframe/vault"
import { app, type BrowserWindow, dialog, shell } from "electron"
import type { AppStatus } from "../shared/ipc.ts"
import { registerHandlers } from "./ipc.ts"
import { newProjectDir, ProjectSession, projectFileName, targetUrl } from "./project.ts"
import { setAppMenu } from "./menu.ts"
import { isSafeExternal } from "./security.ts"
import { readStatus } from "./status.ts"
import { KeyStore } from "./settings.ts"
import { createWindow, hardenSessions, registerAppScheme, serveApp } from "./window.ts"

const here = fileURLToPath(new URL(".", import.meta.url))
// The dev server (electron-vite dev), trusted only in an unpackaged build.
const devServer = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL
// A development build keeps its own profile (lock, keychain entry, takes) beside the installed
// app, unless a profile is given (the end-to-end test gives a throwaway one).
const dev = !app.isPackaged
if (dev && !app.commandLine.hasSwitch("user-data-dir")) {
  app.setPath("userData", join(app.getPath("appData"), `${app.getName()} (dev)`))
}

// One instance: the take store relies on one process (its sweep would remove a live recording).
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  registerAppScheme()
  start()
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

function start(): void {
  let window: BrowserWindow | null = null
  // Tests (unpackaged builds only) keep the key in memory: CI has no keychain.
  const memory = dev && process.env.KIFRAME_TEST_KEYCHAIN === "memory"
  const keys = new KeyStore(
    memory ? memoryBackend() : keychainBackend(`${app.getName()} app${dev ? " (dev)" : ""}`),
  )
  const project = new ProjectSession()
  let error: string | null = null

  const status = () => readStatus(() => keys.hasKey(), project.view(), error)
  /** Runs one action: its failure becomes the status's error (cleared by the next action). */
  const act = async (work: () => Promise<void> | void): Promise<AppStatus> => {
    error = null
    try {
      await work()
    } catch (e) {
      error = message(e)
    }
    return status()
  }

  /** The window a dialog belongs to (modal to it: never opened behind it). */
  const parent = (): BrowserWindow => {
    if (window === null) throw new Error("no window to show the dialog in")
    return window
  }

  const showWindow = () => {
    if (window === null) {
      window = createWindow(join(here, "../preload"), devServer)
      window.on("closed", () => {
        window = null
      })
      return
    }
    if (window.isMinimized()) window.restore()
    window.focus()
  }

  // Launched again: this instance's window (made again if every window was closed, on macOS).
  app.on("second-instance", () => {
    if (app.isReady()) showWindow()
  })
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit()
  })

  void app.whenReady().then(() => {
    setAppMenu(dev)
    hardenSessions(devServer)
    serveApp(join(here, "../renderer"))
    registerHandlers(
      {
        "app:status": status,
        "key:set": (key) => act(() => keys.set(key)),
        "key:clear": () =>
          act(async () => {
            // Asked in main: the key is gone for good (it's never shown again).
            const { response } = await dialog.showMessageBox(parent(), {
              type: "warning",
              message: "Remove the OpenRouter key?",
              detail: "Kiframe forgets it; you paste a key again to keep working.",
              buttons: ["Remove key", "Cancel"],
              defaultId: 1,
              cancelId: 1,
            })
            if (response === 0) await keys.clear()
          }),
        "project:create": (init) =>
          act(async () => {
            const url = targetUrl(init.url)
            const picked = await dialog.showSaveDialog(parent(), {
              title: "Create a project",
              buttonLabel: "Create",
              defaultPath: join(app.getPath("documents"), projectFileName(init.name)),
              properties: ["createDirectory", "showOverwriteConfirmation"],
            })
            if (picked.canceled || picked.filePath === undefined) return
            project.create(newProjectDir(picked.filePath), { name: init.name, url })
          }),
        "project:open": () =>
          act(async () => {
            const picked = await dialog.showOpenDialog(parent(), {
              title: "Open a project",
              buttonLabel: "Open",
              properties: ["openDirectory"],
            })
            const dir = picked.filePaths[0]
            if (picked.canceled || dir === undefined) return
            project.open(dir)
          }),
        "project:close": () => act(() => project.close()),
        "external:open": async (url) => {
          if (isSafeExternal(url)) await shell.openExternal(url)
        },
      },
      devServer,
    )
    showWindow()
    app.on("activate", showWindow)
    // Leftovers of a crash (a recording's temporary folders), once the window has shown (never
    // delaying it), before anything records (nothing does until the user acts). Said if it fails.
    window?.once("ready-to-show", () => {
      setImmediate(() => {
        try {
          new TakeStore(join(app.getPath("userData"), "data")).sweep()
        } catch (e) {
          error = `couldn't clean up old recordings: ${message(e)}`
        }
      })
    })
  })
}
