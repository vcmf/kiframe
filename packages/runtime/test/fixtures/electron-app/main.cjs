// A fixture desktop app for the Electron target's tests (never shipped): a window with a button,
// links out, a popup; it writes its data, says what it sees of its environment, and starts a
// detached helper (as a pty host or a daemon would) that only the sandbox sweep can find. It never
// writes macOS preferences: those go to the user's real ~/Library/Preferences whatever the sandbox
// (cfprefsd writes them for the app: a stated residual).
const { app, BrowserWindow, net, protocol } = require("electron")
const { pathToFileURL } = require("node:url")
const { spawn } = require("node:child_process")
const { writeFileSync } = require("node:fs")
const { homedir } = require("node:os")
const { join } = require("node:path")

// "splash": a file: splash window first, the main window then on the app's own scheme (app:).
const splash = process.argv.includes("splash")
if (splash)
  protocol.registerSchemesAsPrivileged([{ scheme: "app", privileges: { standard: true } }])

// "trust-test-cert": a test's own https server (a throwaway certificate) is trusted.
if (process.argv.includes("trust-test-cert"))
  app.commandLine.appendSwitch("ignore-certificate-errors")

// "single": it allows one copy only (as Slack, VS Code, Discord): Chromium's lock, a unix socket
// in its temp folder.
if (
  process.argv.includes("quit-at-once") ||
  (process.argv.includes("single") && !app.requestSingleInstanceLock())
) {
  app.quit()
} else {
  app.whenReady().then(() => {
    const data = app.getPath("userData")
    writeFileSync(
      join(data, "seen.json"),
      JSON.stringify({
        env: Object.keys(process.env),
        home: homedir(),
        userData: data,
        args: process.argv.slice(1),
      }),
    )
    const helper = spawn("sleep", ["300"], { detached: true, stdio: "ignore", cwd: data })
    helper.unref()
    writeFileSync(join(data, "helper.pid"), String(helper.pid))
    // A child in the app's own process group holding nothing in the sandbox (cwd /): only the
    // group's kill ends it.
    const grouped = spawn("sleep", ["300"], { stdio: "ignore", cwd: "/" })
    writeFileSync(join(data, "grouped.pid"), String(grouped.pid))
    writeFileSync(join(data, "main.pid"), String(process.pid))
    const show = !process.argv.includes("hidden")
    if (splash) {
      protocol.handle("app", (request) =>
        net.fetch(pathToFileURL(join(__dirname, new URL(request.url).pathname)).href),
      )
      const first = new BrowserWindow({ width: 300, height: 200, show })
      first.loadFile(join(__dirname, "other.html"))
      setTimeout(() => {
        const main = new BrowserWindow({ width: 700, height: 500, show })
        main.loadURL("app://local/index.html")
      }, 800)
      return
    }
    // "swap": a sign-in window first, replaced by the main window a moment later (no opener).
    if (process.argv.includes("swap")) {
      const signIn = new BrowserWindow({ width: 400, height: 300, show })
      signIn.loadFile(join(__dirname, "other.html"))
      setTimeout(() => {
        const main = new BrowserWindow({ width: 700, height: 500, show })
        main.loadFile(join(__dirname, "index.html"))
        main.webContents.once("did-finish-load", () => signIn.close())
      }, 2500)
      return
    }
    const win = new BrowserWindow({ width: 700, height: 500, show })
    // "prefs": its main process opens a Preferences window a moment later (no opener).
    if (process.argv.includes("prefs")) {
      setTimeout(() => {
        const prefs = new BrowserWindow({ width: 500, height: 400, show })
        prefs.loadFile(join(__dirname, "other.html"))
      }, 2500)
    }
    // "devtools": it opens DevTools itself (a dev build).
    if (process.argv.includes("devtools")) {
      win.webContents.once("did-finish-load", () =>
        win.webContents.openDevTools({ mode: "detach" }),
      )
    }
    // "elsewhere": its window shows a page that's never an app's own (a data: page).
    // "link=<url>": the other site its links and windows go to (a test's local server);
    // "embed-at-start": it shows that site in a frame as it opens.
    const link = process.argv.find((a) => a.startsWith("link="))?.slice(5) ?? "https://example.com/"
    const query = { link, ...(process.argv.includes("embed-at-start") && { embed: "1" }) }
    // "wrapper": its window is a site (as Slack's app.slack.com), one that never loads (.invalid).
    if (process.argv.includes("wrapper")) win.loadURL("https://kiframe-wrapper.invalid/client")
    else if (process.argv.includes("elsewhere")) win.loadURL("data:text/html,<h1>Elsewhere</h1>")
    else win.loadFile(join(__dirname, "index.html"), { query })
  })
  app.on("window-all-closed", () => app.quit())
}

// "touch-arg": it edits what it was given to open (the files/ copy: never the project's own).
const opened = process.argv.find((a) => a.includes("/files/"))
if (process.argv.includes("touch-arg") && opened !== undefined) {
  app.whenReady().then(() => writeFileSync(join(opened, "note.md"), "edited by the app"))
}

// "probes": each escape the confinement must refuse, tried and written down (never the user's
// data: a write would only create a probe file the test removes; reads only list folders).
if (process.argv.includes("probes")) {
  app.whenReady().then(async () => {
    const fs = require("node:fs")
    const net = require("node:net")
    const { execFileSync } = require("node:child_process")
    const real = require("node:os").userInfo().homedir
    const outside = process.argv.find((a) => a.startsWith("outside="))?.slice(8) ?? "/nonexistent"
    const out = {}
    const tryIt = (name, fn) => {
      try {
        out[name] = "OK " + String(fn()).slice(0, 40)
      } catch (e) {
        out[name] = "DENIED " + (e.code ?? String(e).slice(0, 40))
      }
    }
    tryIt("write-real-home", () => fs.writeFileSync(join(real, "Library", "KiframeProbe.txt"), "x"))
    tryIt("read-real-home", () => fs.readdirSync(join(real, "Library")).length)
    tryIt("write-users-shared", () => fs.writeFileSync("/Users/Shared/KiframeProbe.txt", "x"))
    tryIt("write-private-tmp", () => fs.writeFileSync("/private/tmp/KiframeProbe.txt", "x"))
    tryIt("write-applications", () => fs.writeFileSync("/Applications/KiframeProbe.txt", "x"))
    tryIt("read-outside", () => fs.readFileSync(outside, "utf8"))
    tryIt("hardlink-outside", () => fs.linkSync(outside, join(app.getPath("userData"), "linked")))
    tryIt("exec-open", () =>
      execFileSync("/usr/bin/open", ["-h"], { stdio: "ignore", timeout: 3000 }),
    )
    tryIt("exec-osascript", () =>
      execFileSync("/usr/bin/osascript", ["-e", "1"], { timeout: 3000 }),
    )
    tryIt("exec-launchctl", () => execFileSync("/bin/launchctl", ["version"], { timeout: 3000 }))
    // A unix socket that would accept (the test's own server, outside the sandbox): an agent's.
    const socket = process.argv.find((a) => a.startsWith("socket="))?.slice(7) ?? "/nonexistent"
    out["socket-agent"] = await new Promise((resolve) => {
      const s = net.connect(socket)
      s.on("connect", () => (s.destroy(), resolve("OK connected")))
      s.on("error", (e) => resolve("DENIED " + e.code))
    })
    // A program copied into its own sandbox, run from there (a copied launcher: an exact-path rule
    // would miss it). `true`: it runs, or it's refused.
    tryIt("exec-copied", () => {
      const copy = join(app.getPath("userData"), "copied")
      fs.copyFileSync("/usr/bin/true", copy)
      fs.chmodSync(copy, 0o755)
      return execFileSync(copy, [], { stdio: "ignore", timeout: 3000 })
    })
    // The user's clipboard (it may hold a password just copied): only how much is seen, never what.
    const { safeStorage, clipboard } = require("electron")
    out["clipboard-read"] = `${(await clipboard.readText()).length}`
    tryIt("keychain-encrypts", () => safeStorage.isEncryptionAvailable())
    fs.writeFileSync(join(app.getPath("userData"), "probes.json"), JSON.stringify(out))
  })
}
