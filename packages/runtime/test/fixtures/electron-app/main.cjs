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

if (process.argv.includes("quit-at-once")) {
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
    if (process.argv.includes("elsewhere")) win.loadURL("data:text/html,<h1>Elsewhere</h1>")
    else win.loadFile(join(__dirname, "index.html"), { query })
  })
  app.on("window-all-closed", () => app.quit())
}
