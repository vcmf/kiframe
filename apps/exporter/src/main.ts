// Electron main process of the exporter: loads the export page in a hidden window (Electron's
// Chromium has the platform's H.264 encoder), runs the export there and writes the file.
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { app, BrowserWindow, protocol } from "electron"

/** What the CLI passes (as JSON in KIFRAME_EXPORT). */
export interface ExportJob {
  /** Folder with export.html and export.js. */
  pageDir: string
  takeDir: string
  out: string
  /** Everything the page's `kiframeExport` needs, except the video URL. */
  args: Record<string, unknown>
}

const job = JSON.parse(process.env.KIFRAME_EXPORT ?? "null") as ExportJob | null
if (job === null) {
  console.error("KIFRAME_EXPORT is not set: run the exporter through its CLI")
  process.exit(2)
}

// A privileged scheme: the page is a secure context (WebCodecs needs one) and can fetch the take.
protocol.registerSchemesAsPrivileged([
  { scheme: "kiframe", privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

const types: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".webm": "video/webm",
}

async function run(job: ExportJob): Promise<void> {
  protocol.handle("kiframe", (request) => {
    const { host, pathname } = new URL(request.url)
    // One origin (the page fetches the take), two fixed files: nothing else is served.
    const file =
      host !== "app"
        ? undefined
        : pathname === "/export.html" || pathname === "/export.js"
          ? join(job.pageDir, pathname)
          : pathname === "/take/frames.webm"
            ? join(job.takeDir, "frames.webm")
            : undefined
    if (file === undefined) return new Response("not found", { status: 404 })
    const ext = file.slice(file.lastIndexOf("."))
    return new Response(readFileSync(file), { headers: { "content-type": types[ext] ?? "" } })
  })
  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } })
  await win.loadURL("kiframe://app/export.html")
  await win.webContents.executeJavaScript(
    "new Promise((r) => { const w = () => (window.kiframeExport ? r() : setTimeout(w, 20)); w() })",
  )
  const args = { ...job.args, videoUrl: "kiframe://app/take/frames.webm" }
  const result = (await win.webContents.executeJavaScript(
    `window.kiframeExport(${JSON.stringify(args)})`,
  )) as { data: string; codec: string; frames: number; durationMs: number; softness: number }
  writeFileSync(job.out, Buffer.from(result.data, "base64"))
  const { data: _data, ...summary } = result
  console.log(JSON.stringify(summary))
}

app.whenReady().then(
  () =>
    run(job).then(
      () => app.exit(0),
      (error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error))
        app.exit(1)
      },
    ),
  () => app.exit(1),
)
