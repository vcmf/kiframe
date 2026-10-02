// Kiframe's main process: one instance, the hardened window, and the handlers of the contract.
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { TakeStore } from "@kiframe/project"
import { keychainBackend, memoryBackend } from "@kiframe/vault"
import { app, type BrowserWindow, dialog, shell } from "electron"
import type { AppStatus } from "../shared/ipc.ts"
import { emit, registerHandlers } from "./ipc.ts"
import { PROJECT_EXTENSION, ProjectSession } from "./project.ts"
import { isSafeExternal } from "./security.ts"
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

function start(): void {
  let window: BrowserWindow | null = null
  // Tests (unpackaged builds only) keep the key in memory: CI has no keychain.
  const memory = dev && process.env.KIFRAME_TEST_KEYCHAIN === "memory"
  const keys = new KeyStore(
    memory ? memoryBackend() : keychainBackend(`${app.getName()} app${dev ? " (dev)" : ""}`),
  )
  const project = new ProjectSession()
  let error: string | null = null

  const status = async (): Promise<AppStatus> => ({
    hasKey: await keys.hasKey(),
    project: project.view(),
    error,
  })
  /** Runs one action: its failure becomes the status's error (cleared by the next action). */
  const act = async (work: () => Promise<void> | void): Promise<AppStatus> => {
    error = null
    try {
      await work()
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
    const now = await status()
    emit(window, "status", now)
    return now
  }

  app.on("second-instance", () => {
    if (window === null) return
    if (window.isMinimized()) window.restore()
    window.focus()
  })
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit()
  })

  void app.whenReady().then(() => {
    // Leftovers of a crash (a recording's temporary folders) go before anything records.
    new TakeStore(join(app.getPath("userData"), "data")).sweep()
    hardenSessions(devServer)
    serveApp(join(here, "../renderer"))
    registerHandlers(
      {
        "app:status": status,
        "key:set": (key) => act(() => keys.set(key)),
        "key:clear": () => act(() => keys.clear()),
        "project:create": (init) =>
          act(async () => {
            const picked = await dialog.showSaveDialog({
              title: "Create a project",
              buttonLabel: "Create",
              defaultPath: join(app.getPath("documents"), `${init.name}${PROJECT_EXTENSION}`),
              properties: ["createDirectory", "showOverwriteConfirmation"],
            })
            if (picked.canceled || picked.filePath === undefined) return
            const dir = picked.filePath.endsWith(PROJECT_EXTENSION)
              ? picked.filePath
              : `${picked.filePath}${PROJECT_EXTENSION}`
            project.create(dir, init)
          }),
        "project:open": () =>
          act(async () => {
            const picked = await dialog.showOpenDialog({
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
    window = createWindow(join(here, "../preload"), devServer)
    window.on("closed", () => {
      window = null
    })
    app.on("activate", () => {
      if (window === null) {
        window = createWindow(join(here, "../preload"), devServer)
        window.on("closed", () => {
          window = null
        })
      }
    })
  })
}
