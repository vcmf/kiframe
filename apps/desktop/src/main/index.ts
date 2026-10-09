// Kiframe's main process: one instance, the hardened window, and the handlers of the contract.
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { type LlmClient, OpenAiCompatibleClient } from "@kiframe/agent"
import { type OpenedProject, TakeStore } from "@kiframe/project"
import { defaultWorkDir, inspectDesktopApp, sweepWorkArea, trialDesktopApp } from "@kiframe/runtime"
import { keychainBackend, memoryBackend } from "@kiframe/vault"
import { app, type BrowserWindow, dialog, shell } from "electron"
import { type Browser, chromium } from "playwright"
import type { AppStatus } from "../shared/ipc.ts"
import { errorMessage } from "../shared/util.ts"
import { AgentHost } from "./agent.ts"
import {
  addHostOf,
  DesktopAdds,
  DesktopApprovals,
  desktopStatus,
  endAddsOnSwitch,
  type Looks,
} from "./desktop-apps.ts"
import { FileVersions } from "./file-versions.ts"
import { resolveAppAddress } from "./app-address.ts"
import { emit, registerHandlers } from "./ipc.ts"
import { DEFAULT_MODEL, imageInput, modelConfig } from "./model.ts"
import {
  secretOriginOf,
  appRemovalRefused,
  newProjectDir,
  projectFileName,
  interruptsUsing,
  presetsUsing,
  removeApp,
  scenesUsing,
  targetUrl,
} from "./project.ts"
import { setAppMenu } from "./menu.ts"
import { isSafeExternal } from "./security.ts"
import { Registry } from "./registry.ts"
import { Secrets } from "./secrets.ts"
import { readStatus } from "./status.ts"
import { workerInspector } from "./folder-reader.ts"
import makeFolderWorker from "./folder-worker.ts?nodeWorker"
import icon from "../../resources/icon.png?asset"
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
  /**
   * The browser the agent works in: launched on first use, shared by every project, closed with
   * the project (and at quit). Each launch forgets only itself (a late event of an old browser
   * never drops a newer one).
   */
  let browser: Promise<Browser> | undefined
  /** Browsers being closed (a quit meanwhile waits for them). */
  const closing = new Set<Promise<void>>()
  const launch = async (): Promise<Browser> => {
    if (browser !== undefined) return browser
    const launched: Promise<Browser> = chromium.launch({ headless: true }).then(
      (b) => {
        // Crashed or killed: the next run launches another.
        b.on("disconnected", () => {
          if (browser === launched) browser = undefined
        })
        return b
      },
      (e: unknown) => {
        if (browser === launched) browser = undefined
        throw new Error(`Kif's browser didn't start: ${message(e)}`)
      },
    )
    browser = launched
    return launched
  }
  /** Lets the browser go (the next run launches another); its close is tracked in `closing`. */
  const dropBrowser = (): void => {
    const current = browser
    browser = undefined
    if (current === undefined) return
    const done: Promise<void> = current
      .then((b) => b.close())
      .catch(() => undefined)
      .finally(() => closing.delete(done))
    closing.add(done)
  }
  // Tests (unpackaged builds only) script the model: no network, no key spent.
  const testModel = dev ? process.env.KIFRAME_TEST_MODEL : undefined
  // One script for the app's whole run: its turns go on from one message to the next.
  const scripted = testModel !== undefined ? scriptedModel(testModel) : undefined
  // Whether the model takes images: OpenRouter asked once (a scripted model: no network, it does).
  const takesImages = imageInput()
  const seesImages = (): Promise<boolean> =>
    scripted !== undefined ? Promise.resolve(true) : takesImages(DEFAULT_MODEL)
  // Asked at start: the answer is there before the agent's first look.
  void seesImages()
  const model = async (): Promise<LlmClient> => {
    if (scripted !== undefined) return scripted
    const apiKey = await keys.key()
    if (apiKey === undefined) throw new Error("no OpenRouter key: add one first")
    return OpenAiCompatibleClient.fromConfig(modelConfig(apiKey))
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
  /** A secret's origin: a web app's (a desktop app takes none). */
  const secretOrigin = (session: string, app: string) =>
    secretOriginOf(workspace.apps(), session, app)

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
      const scope = registry.scope(opened.dir)
      const host: AgentHost = new AgentHost({
        project: opened,
        afterRecord: () =>
          void keeper
            ?.evict()
            .catch((e: unknown) => say(`couldn't tidy old recordings: ${message(e)}`)),
        scope,
        sceneKey: (sceneId) => registry.sceneKey(opened.dir, sceneId),
        takes,
        browser: launch,
        llm: model,
        model: DEFAULT_MODEL,
        seesImages,
        secrets: vaultOrNull,
        // The files the agent replaces or deletes, kept first (by the host's scope for the folder).
        versions: new FileVersions(join(app.getPath("userData"), "versions", scope)),
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

  // Desktop apps (macOS): inspected and tried by the runtime; approvals in app data.
  const looks: Looks = { inspect: inspectDesktopApp, trial: trialDesktopApp }
  // Kiframe's work area (~/.kiframe); a test's own (never the user's) when it names one.
  const workDir = process.env.KIFRAME_WORK_DIR ?? defaultWorkDir()
  const adds: DesktopAdds = new DesktopAdds(
    looks,
    addHostOf(workspace, {
      pickApp: async () => {
        const picked = await dialog.showOpenDialog(parent(), {
          title: "Add a desktop app",
          buttonLabel: "Choose",
          defaultPath: "/Applications",
          properties: ["openFile"],
          filters: [{ name: "Applications", extensions: ["app"] }],
        })
        return picked.canceled ? undefined : picked.filePaths[0]
      },
      approve: (picked, opened, opens) =>
        desktopApprovals().approve(picked, ids().scope(opened.dir), opens),
      changed: (opened) => appsChanged(opened),
    }),
    workDir,
  )
  // Every add ends, its trial too, as the project switches.
  endAddsOnSwitch(workspace, adds)
  let approvals: DesktopApprovals | undefined
  const desktopApprovals = (): DesktopApprovals =>
    (approvals ??= new DesktopApprovals(app.getPath("userData")))
  /** The open project, if it's this session's (else why not). */
  const sessionProject = (session: string): OpenedProject | string => {
    const opened = workspace.opened
    if (opened === null || workspace.session !== session) return "the project changed"
    return opened
  }
  /** The project's apps changed: its agent and the window told (never another project's). */
  const appsChanged = (opened: OpenedProject): void => {
    if (workspace.opened !== opened) return
    workspace.agent?.appsChanged(opened.project.apps)
    void status().then((now) => {
      if (workspace.opened === opened) emit(window, "status", now)
    })
  }
  const owner = () => window?.webContents.id ?? 0

  /** The window a dialog belongs to (modal to it: never opened behind it). */
  const parent = (): BrowserWindow => {
    if (window === null) throw new Error("no window to show the dialog in")
    return window
  }

  const showWindow = () => {
    if (window === null) {
      window = createWindow(join(here, "../preload"), icon, devServer)
      const closing = window.webContents.id
      // A reload keeps the id: its add given up all the same (the window starts afresh).
      window.webContents.on("did-start-navigation", (event) => {
        if (event.isMainFrame && !event.isSameDocument) adds.dropFor(closing)
      })
      window.on("closed", () => {
        // Its add dropped, its trial ended (macOS keeps the app open without a window).
        adds.dropFor(closing)
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
    // Every desktop app's trial ended (its confined app killed with it).
    adds.dropAll()
    const work = (async () => {
      // The browser let go within the close, as for project:close (an open in flight never comes
      // between); a close refused still lets it go: the app is quitting.
      await workspace.close(dropBrowser).catch(() => undefined)
      dropBrowser()
      folders.close()
      await Promise.all(closing)
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
    keeper = new TakeKeeper(takes, projects, folders.inspect, () => workspace.opened?.project.id)
    setAppMenu(dev)
    // The Dock takes its icon from here (no packaged bundle carries one yet).
    if (process.platform === "darwin") app.dock?.setIcon(icon)
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
            // Where the address really lands (its www. or https form), asked while the user picks.
            const resolving = resolveAppAddress(url)
            const picked = await dialog.showSaveDialog(parent(), {
              title: "Create a project",
              buttonLabel: "Create",
              defaultPath: join(app.getPath("documents"), projectFileName(init.name)),
              properties: ["createDirectory", "showOverwriteConfirmation"],
            })
            if (picked.canceled || picked.filePath === undefined) return
            const address = await resolving
            await workspace.create(newProjectDir(picked.filePath), {
              name: init.name,
              url: address,
            })
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
        // No project, no agent: its browser closed too (launched again by the next project).
        "project:close": () =>
          // The browser's close isn't waited for (one that hangs never holds the window); a quit
          // waits for it.
          act(() => workspace.close(dropBrowser)),
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
        "chat:send": (text, files) => {
          const agent = workspace.agent
          return agent === undefined ? "open a project first" : agent.send(text, files ?? [])
        },
        // An unreadable vault says why here (projects still open: a secret step can't run).
        "secrets:list": async () => {
          const secrets = vault()
          await secrets.ready()
          // Web apps only: a desktop app takes no secrets.
          const apps = (workspace.apps()?.apps ?? []).filter((a) => a.kind === "web")
          return apps.map(({ name, origin }) => ({
            app: name,
            origin,
            secrets: secrets.list(origin),
          }))
        },
        "secrets:add": async ({ session, app, ...form }) => {
          const at = secretOrigin(session, app)
          if ("why" in at) return at.why
          try {
            await vault().add(form, at.origin)
            return null
          } catch (e) {
            // A refusal names the secret and why, never the value.
            return message(e)
          }
        },
        "secrets:remove": async ({ session, app, name }) => {
          const at = secretOrigin(session, app)
          if ("why" in at) return at.why
          try {
            await vault().remove(name, at.origin)
            return null
          } catch (e) {
            return message(e)
          }
        },
        "apps:remove": async ({ session, name, identity }) => {
          // Checked before asking and again after (the dialog waits on the user meanwhile).
          const refused = () =>
            appRemovalRefused(
              workspace.apps(),
              { session, name, identity },
              workspace.agent?.running === true,
            )
          const before = refused()
          const opened = workspace.opened
          if (before !== null) return before
          if (opened === null) return "open a project first"
          const uses = scenesUsing(opened, name)
          const presets = presetsUsing(opened, name)
          const rules = interruptsUsing(opened, name)
          const presetNote =
            presets.length === 0
              ? ""
              : ` ${presets.length === 1 ? "Preset" : "Presets"} ${presets.map((p) => `“${p}”`).join(", ")} ${presets.length === 1 ? "names" : "name"} it too: the scenes using ${presets.length === 1 ? "it" : "them"} will need it changed.`
          const ruleNote =
            rules.length === 0
              ? ""
              : ` ${rules.length === 1 ? "The interrupt rule" : "The interrupt rules"} ${rules.map((r) => `“${r}”`).join(", ")} ${rules.length === 1 ? "goes" : "go"} there: ${rules.length === 1 ? "it" : "they"} will fail until changed.`
          const { response } = await dialog.showMessageBox(parent(), {
            type: "warning",
            message: `Remove ${name} (${identity}) from the project?`,
            detail:
              (uses.length === 0
                ? "No scene uses it. Its saved secrets stay; its approvals in this project go."
                : `${uses.length} ${uses.length === 1 ? "scene uses" : "scenes use"} it: ${uses.map((t) => `“${t}”`).join(", ")}. They'll need reworking (their recordings still play). Its saved secrets stay; its approvals in this project go.`) +
              presetNote +
              ruleNote,
            buttons: ["Remove", "Cancel"],
            defaultId: 1,
            cancelId: 1,
          })
          if (response !== 0) return null
          const after = refused()
          if (after !== null || workspace.opened !== opened) return after ?? "the project changed"
          // This project's approvals on that site go first (the secrets stay: other projects may
          // use them): a failure below leaves the app with its approvals asked again, never kept.
          // A desktop app has none (it takes no secrets).
          const removed = workspace.apps()?.apps.find((a) => a.name === name)
          try {
            if (removed?.kind === "web") vault().revokeAt(ids().scope(opened.dir), removed.origin)
          } catch (e) {
            return `not removed: its approvals couldn't be revoked: ${message(e)}`
          }
          try {
            removeApp(opened, name)
          } catch (e) {
            return message(e)
          }
          // A desktop app's approval in this project goes with it (its other projects' stay).
          if (removed?.kind === "electron") {
            try {
              desktopApprovals().drop(removed.bundleId, ids().scope(opened.dir))
            } catch (e) {
              say(`its approval on this Mac couldn't be removed: ${message(e)}`)
            }
          }
          appsChanged(opened)
          return null
        },
        "apps:desktop-pick": async ({ session }) => {
          if (process.platform !== "darwin") {
            return { refused: "desktop apps run on macOS only (they're confined there)" }
          }
          try {
            const card = await adds.pick(owner(), session)
            return card === null ? null : { card }
          } catch (e) {
            return { refused: message(e) }
          }
        },
        "apps:desktop-check": async ({ session, token, allowSite }) => {
          try {
            return await adds.check(owner(), session, token, allowSite)
          } catch (e) {
            return { failed: message(e) }
          }
        },
        "apps:desktop-add": async ({ session, token }) => {
          try {
            await adds.add(owner(), session, token)
            return null
          } catch (e) {
            return message(e)
          }
        },
        "apps:desktop-cancel": () => adds.dropFor(owner()),
        "apps:desktop-status": async ({ session }) => {
          const opened = sessionProject(session)
          const apps: Record<string, Awaited<ReturnType<typeof desktopStatus>>> = {}
          if (typeof opened === "string") return { apps, problem: null }
          const store = desktopApprovals()
          const scope = ids().scope(opened.dir)
          await Promise.all(
            Object.entries(opened.project.apps).map(async ([name, entry]) => {
              if (entry.kind !== "electron") return
              apps[name] =
                process.platform === "darwin"
                  ? await desktopStatus(entry, scope, store, looks)
                  : { status: "not-found", why: "desktop apps run on macOS only" }
            }),
          )
          return { apps, problem: store.takeProblem() }
        },
        "preview:open": (sceneId) => {
          const opened = workspace.opened
          if (opened === null) return { ok: false, why: "No project is open." }
          return previewOf(opened, ready().takes, sceneId)
        },
        "chat:stop": () => workspace.agent?.stop(),
        "chat:answer": (id, answer) => workspace.agent?.answer(id, answer),
        "live:input": (id, gen, event) => workspace.agent?.input(id, gen, event),
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
        // What a crash left of desktop apps' launches (never another running Kiframe's).
        if (process.platform === "darwin") {
          sweepWorkArea(workDir).catch((e: unknown) =>
            say(`couldn't clean up desktop apps' leftovers: ${message(e)}`),
          )
        }
        // Sealed, then scratch beyond the budget (said if it fails).
        void sealTakes().then(() =>
          keeper?.evict().catch((e: unknown) => say(`couldn't tidy old recordings: ${message(e)}`)),
        )
      })
    })
  })
}
