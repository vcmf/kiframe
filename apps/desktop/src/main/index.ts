// Kiframe's main process: one instance, the hardened window, and the handlers of the contract.
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { type LlmClient, OpenAiCompatibleClient } from "@kiframe/agent"
import { type OpenedProject, TakeStore } from "@kiframe/project"
import { keychainBackend, memoryBackend } from "@kiframe/vault"
import { app, type BrowserWindow, dialog, shell } from "electron"
import { type Browser, chromium } from "playwright"
import type { AppStatus } from "../shared/ipc.ts"
import { AgentHost } from "./agent.ts"
import { emit, registerHandlers } from "./ipc.ts"
import { newProjectDir, ProjectSession, projectFileName, targetUrl } from "./project.ts"
import { setAppMenu } from "./menu.ts"
import { isSafeExternal } from "./security.ts"
import { Registry } from "./registry.ts"
import { readStatus } from "./status.ts"
import { KeyStore } from "./settings.ts"
import { scriptedModel } from "./test-model.ts"
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

/** The agent's model by default (OpenRouter ids; a picker comes later). */
export const DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash"

function start(): void {
  let window: BrowserWindow | null = null
  // Tests (unpackaged builds only) keep the key in memory: CI has no keychain.
  const memory = dev && process.env.KIFRAME_TEST_KEYCHAIN === "memory"
  const keys = new KeyStore(
    memory ? memoryBackend() : keychainBackend(`${app.getName()} app${dev ? " (dev)" : ""}`),
  )
  const project = new ProjectSession()
  let error: string | null = null
  // App data, once ready: the take store and the host's ids (approval scopes, scene keys).
  let takes: TakeStore | undefined
  let registry: Registry | undefined
  /** The open project's agent (one per project, closed before another opens). */
  let agent: AgentHost | undefined
  /** The browser the agent works in: launched on first use, shared by every project. */
  let browser: Promise<Browser> | undefined
  const launch = (): Promise<Browser> => {
    browser ??= chromium.launch({ headless: true }).catch((e: unknown) => {
      browser = undefined
      throw new Error(`the agent's browser didn't start: ${message(e)}`)
    })
    return browser
  }
  // Tests (unpackaged builds only) script the model: no network, no key spent.
  const testModel = dev ? process.env.KIFRAME_TEST_MODEL : undefined
  // One script for the app's whole run: its turns go on from one message to the next.
  const scripted = testModel !== undefined ? scriptedModel(testModel) : undefined
  const model = async (): Promise<LlmClient> => {
    if (scripted !== undefined) return scripted
    const apiKey = await keys.key()
    if (apiKey === undefined) throw new Error("no OpenRouter key: add one first")
    return OpenAiCompatibleClient.fromConfig({ apiKey, model: DEFAULT_MODEL })
  }

  /** Makes `opened` the open project (null: none): the old one's agent stops and closes first. */
  const switchTo = async (opened: OpenedProject | null): Promise<void> => {
    const old = agent
    agent = undefined
    await old?.close()
    if (opened === null || takes === undefined || registry === undefined) return
    const ids = registry
    agent = new AgentHost({
      project: opened,
      scope: ids.scope(opened.dir),
      sceneKey: (sceneId) => ids.sceneKey(opened.dir, sceneId),
      takes,
      browser: launch,
      llm: model,
      model: DEFAULT_MODEL,
      item: (item) => emit(window, "chat:item", item),
      running: (running) => emit(window, "chat:running", running),
      frame: (frame) => emit(window, "live:frame", frame),
      projectChanged: () => void status().then((now) => emit(window, "status", now)),
    })
  }

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

  // Quitting: the run stops, the browser closes (no Chromium left behind), then the app quits.
  let quitting = false
  app.on("before-quit", (event) => {
    if (quitting) return
    quitting = true
    event.preventDefault()
    void (async () => {
      await switchTo(null).catch(() => undefined)
      await (await browser?.catch(() => undefined))?.close().catch(() => undefined)
      app.quit()
    })()
  })

  void app.whenReady().then(() => {
    const data = app.getPath("userData")
    takes = new TakeStore(join(data, "data"))
    try {
      registry = new Registry(data)
    } catch (e) {
      // Never replaced (approvals hang on it): the agent waits until it reads again.
      error = `couldn't read the project registry (${join(data, "registry.json")}): ${message(e)}`
    }
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
            await switchTo(project.create(newProjectDir(picked.filePath), { name: init.name, url }))
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
            // Opened first: a folder that doesn't open keeps the current project (and its agent).
            const opened = project.peek(dir)
            await switchTo(opened)
            project.use(opened)
          }),
        "project:close": () =>
          act(async () => {
            await switchTo(null)
            project.close()
          }),
        "external:open": async (url) => {
          if (isSafeExternal(url)) await shell.openExternal(url)
        },
        "chat:state": () => agent?.state() ?? { items: [], running: false, model: DEFAULT_MODEL },
        // `send` answers null when the run started: never read as "no agent".
        "chat:send": (text) => (agent === undefined ? "open a project first" : agent.send(text)),
        "chat:stop": () => agent?.stop(),
        "chat:answer": (id, answer) => agent?.answer(id, answer),
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
          takes?.sweep()
        } catch (e) {
          // After the window's first read: pushed to it (not an action's result).
          error = `couldn't clean up old recordings: ${message(e)}`
          void status().then((now) => emit(window, "status", now))
        }
      })
    })
  })
}
