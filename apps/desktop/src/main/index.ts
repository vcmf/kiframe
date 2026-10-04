// Kiframe's main process: one instance, the hardened window, and the handlers of the contract.
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { type LlmClient, OpenAiCompatibleClient } from "@kiframe/agent"
import { type OpenedProject, TakeStore } from "@kiframe/project"
import { keychainBackend, memoryBackend } from "@kiframe/vault"
import { app, type BrowserWindow, dialog, shell } from "electron"
import { type Browser, chromium } from "playwright"
import type { AppStatus } from "../shared/ipc.ts"
import { errorMessage } from "../shared/util.ts"
import { AgentHost } from "./agent.ts"
import { emit, registerHandlers } from "./ipc.ts"
import { newProjectDir, projectFileName, targetUrl } from "./project.ts"
import { setAppMenu } from "./menu.ts"
import { isSafeExternal } from "./security.ts"
import { Registry } from "./registry.ts"
import { Secrets } from "./secrets.ts"
import { readStatus } from "./status.ts"
import { workerInspector } from "./folder-reader.ts"
import makeFolderWorker from "./folder-worker.ts?nodeWorker"
import { ProjectIndex } from "./project-index.ts"
import { KeyStore, takeStoreKey } from "./settings.ts"
import { TakeKeeper } from "./take-keeper.ts"
import { scriptedModel } from "./test-model.ts"
import { previewOf } from "./preview.ts"
import { Workspace } from "./workspace.ts"
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

const message = errorMessage

/** The agent's model by default (OpenRouter ids; a picker comes later). */
export const DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash"
/** How long quitting waits for the run and the browser to close. */
const QUIT_WAIT_MS = 5000

function start(): void {
  let window: BrowserWindow | null = null
  // Tests (unpackaged builds only) keep the key in memory: CI has no keychain.
  const memory = dev && process.env.KIFRAME_TEST_KEYCHAIN === "memory"
  // The app's own keychain entries: the OpenRouter key, the take store's key.
  const appKeychain = memory
    ? memoryBackend()
    : keychainBackend(`${app.getName()} app${dev ? " (dev)" : ""}`)
  const keys = new KeyStore(appKeychain)
  let error: string | null = null
  // App data, once ready: the take store and the host's ids (approval scopes, scene keys).
  let takes: TakeStore | undefined
  /** The projects opened (their folders), and the take store's bookkeeping: once ready. */
  let projects: ProjectIndex | undefined
  let keeper: TakeKeeper | undefined
  // Folders are read in a worker (a stuck network mount never freezes the app).
  const folders = workerInspector(() => makeFolderWorker({}))
  let registry: Registry | undefined
  /** The app's secrets (the vault in app data, values in the keychain), once ready. */
  let secrets: Secrets | undefined
  /** The host's ids: read when first needed, and again after a failure (never replaced). */
  const ids = (): Registry => {
    if (registry !== undefined) return registry
    const data = app.getPath("userData")
    try {
      registry = new Registry(data)
      return registry
    } catch (e) {
      throw new Error(
        `couldn't read the project registry (${join(data, "registry.json")}): ${message(e)}`,
        { cause: e },
      )
    }
  }
  /** The browser the agent works in: launched on first use, shared by every project. */
  let browser: Promise<Browser> | undefined
  const launch = async (): Promise<Browser> => {
    browser ??= chromium.launch({ headless: true }).then(
      (b) => {
        // Crashed or killed: the next run launches another.
        b.on("disconnected", () => {
          browser = undefined
        })
        return b
      },
      (e: unknown) => {
        browser = undefined
        throw new Error(`the agent's browser didn't start: ${message(e)}`)
      },
    )
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

  /** The app's secrets: the vault read when first needed, and again after a failure (said). */
  const vault = (): Secrets => {
    if (secrets !== undefined) return secrets
    const path = join(app.getPath("userData"), "vault.json")
    try {
      secrets = new Secrets(
        path,
        memory ? memoryBackend() : keychainBackend(`${app.getName()}${dev ? " (dev)" : ""}`),
      )
      return secrets
    } catch (e) {
      // Never replaced (the user would lose track of their secrets).
      throw new Error(`couldn't read the secrets (${path}): ${message(e)}`, { cause: e })
    }
  }
  const vaultOrNull = (): Secrets | undefined => {
    try {
      return vault()
    } catch {
      return undefined
    }
  }

  /**
   * At start, after the sweep: takes a crash left plain (or from before encryption) encrypted.
   * What can't be is said; the app goes on.
   */
  /** A start's problem, added to what's already said (never replacing it). */
  const say = (problem: string): void => {
    error = error === null ? problem : `${error}; ${problem}`
    void status().then((now) => emit(window, "status", now))
  }
  const sealTakes = async (): Promise<void> => {
    if (takes === undefined) return
    try {
      const { failed } = await takes.seal()
      if (failed.length > 0) {
        say(`couldn't encrypt ${failed.length} old recording(s): ${failed[0] ?? ""}`)
      }
    } catch (e) {
      say(`couldn't encrypt old recordings: ${message(e)}`)
    }
  }

  /** What an agent needs (the host's ids, the take store, the secrets): throws when it can't. */
  const ready = (): { registry: Registry; takes: TakeStore } => {
    const registry = ids()
    if (takes === undefined) throw new Error("the app isn't ready yet")
    return { registry, takes }
  }
  /** The open project's app origin (its secrets are those usable there). */
  const origin = (): string | null => {
    const url = workspace.view()?.url
    return url === null || url === undefined ? null : new URL(url).origin
  }

  /**
   * The open project and its agent, switched as one. An agent's events reach the window only while
   * it's the open project's (the one closing never writes into the next one's chat).
   */
  const workspace: Workspace<AgentHost> = new Workspace(
    (opened: OpenedProject) => {
      const { registry, takes } = ready()
      // Known where it's opened from: its takes are read from there (kept while it's there).
      try {
        projects?.seen(opened.project.id, opened.dir)
      } catch {
        // known again at the next opening
      }
      const current = () => workspace.agent === host
      const host: AgentHost = new AgentHost({
        project: opened,
        afterRecord: () =>
          void keeper
            ?.evict()
            .catch((e: unknown) => say(`couldn't tidy old recordings: ${message(e)}`)),
        scope: registry.scope(opened.dir),
        sceneKey: (sceneId) => registry.sceneKey(opened.dir, sceneId),
        takes,
        browser: launch,
        llm: model,
        model: DEFAULT_MODEL,
        secrets: vaultOrNull,
        item: (item) => current() && emit(window, "chat:item", item),
        running: (running) => current() && emit(window, "chat:running", running),
        frame: (frame) => current() && emit(window, "live:frame", frame),
        projectChanged: () => {
          // Checked again once read: a switch meanwhile makes this one stale.
          if (current()) void status().then((now) => current() && emit(window, "status", now))
        },
      })
      return host
    },
    () => void ready(),
  )

  const status = () => readStatus(() => keys.hasKey(), workspace.view(), error)
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

  // Quitting: the run stops, the browser closes (no Chromium left behind), then the app quits. A
  // second quit while that runs waits for it; a cleanup that hangs is cut after QUIT_WAIT_MS.
  let cleanup: "idle" | "running" | "done" = "idle"
  app.on("before-quit", (event) => {
    if (cleanup === "done") return
    event.preventDefault()
    if (cleanup === "running") return
    cleanup = "running"
    const work = (async () => {
      await workspace.close().catch(() => undefined)
      folders.close()
      await (await browser?.catch(() => undefined))?.close().catch(() => undefined)
    })()
    void Promise.race([work, new Promise((r) => setTimeout(r, QUIT_WAIT_MS))]).then(() => {
      cleanup = "done"
      app.quit()
    })
  })

  void app.whenReady().then(() => {
    const data = app.getPath("userData")
    // Takes encrypted at rest with the app's own key (made on first use).
    takes = new TakeStore(join(data, "data"), {
      // The marker only with the OS keychain (a memory one starts empty every launch).
      key: () =>
        takeStoreKey(appKeychain, memory ? undefined : join(data, "data", "take-key-made")),
    })
    projects = new ProjectIndex(join(data, "data"))
    keeper = new TakeKeeper(takes, projects, folders.inspect)
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
            await workspace.create(newProjectDir(picked.filePath), { name: init.name, url })
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
            // A folder that doesn't open keeps the current project (and its agent).
            await workspace.open(dir)
          }),
        "project:close": () => act(() => workspace.close()),
        "external:open": async (url) => {
          if (isSafeExternal(url)) await shell.openExternal(url)
        },
        "chat:state": () =>
          workspace.agent?.state() ?? {
            items: [],
            running: false,
            model: DEFAULT_MODEL,
            frame: null,
          },
        // `send` answers null when the run started: never read as "no agent".
        "chat:send": (text) => {
          const agent = workspace.agent
          return agent === undefined ? "open a project first" : agent.send(text)
        },
        // An unreadable vault says why here (projects still open: a secret step can't run).
        "secrets:list": async () => {
          const secrets = vault()
          await secrets.ready()
          return secrets.list(origin())
        },
        "secrets:add": async (form) => {
          const at = origin()
          if (at === null) return "open a project with an app address first"
          try {
            await vault().add(form, at)
            return null
          } catch (e) {
            // A refusal names the secret and why, never the value.
            return message(e)
          }
        },
        "secrets:remove": async (name) => {
          const at = origin()
          if (at === null) return "open a project with an app address first"
          try {
            await vault().remove(name, at)
            return null
          } catch (e) {
            return message(e)
          }
        },
        "preview:open": (sceneId) => {
          const opened = workspace.opened
          if (opened === null) return { ok: false, why: "No project is open." }
          return previewOf(opened, ready().takes, sceneId)
        },
        "chat:stop": () => workspace.agent?.stop(),
        "chat:answer": (id, answer) => workspace.agent?.answer(id, answer),
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
          say(`couldn't clean up old recordings: ${message(e)}`)
        }
        // Sealed, then removed projects' takes and scratch beyond the budget (said if it fails).
        void sealTakes().then(() =>
          keeper?.tidy().catch((e: unknown) => say(`couldn't tidy old recordings: ${message(e)}`)),
        )
      })
    })
  })
}
