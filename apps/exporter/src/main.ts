// Electron main process of the exporter: loads the export page in a hidden window (Electron's
// Chromium has the platform's H.264 encoder), runs the export there and writes the file.
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { PageExportArgs } from "@kiframe/compositor/browser/export-page.ts"
import { app, BrowserWindow, protocol } from "electron"

/** What the CLI passes (a JSON file whose path is in KIFRAME_EXPORT_JOB). */
export interface ExportJob {
  /** Folder with export.html and export.js. */
  pageDir: string
  takeDir: string
  out: string
  /** The style's background image file (none: the page draws a gradient). */
  backgroundFile?: string
  /** Everything the page's `kiframeExport` needs, except the video and background URLs. */
  args: Omit<PageExportArgs, "videoUrl" | "backgroundUrl">
}

const jobFile = process.env.KIFRAME_EXPORT_JOB
if (jobFile === undefined) {
  console.error("KIFRAME_EXPORT_JOB is not set: run the exporter through its CLI")
  process.exit(2)
}
// A file, not an environment variable: a take's events and cursor samples can be megabytes.
const job = JSON.parse(readFileSync(jobFile, "utf8")) as ExportJob

// A privileged scheme: the page is a secure context (WebCodecs needs one) and can fetch the take.
protocol.registerSchemesAsPrivileged([
  { scheme: "kiframe", privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

const types: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".webm": "video/webm",
  ".jpg": "image/jpeg",
}

async function run(job: ExportJob): Promise<void> {
  protocol.handle("kiframe", (request) => {
    const { host, pathname } = new URL(request.url)
    // One origin (the page fetches the take), fixed files: nothing else is served.
    const file =
      host !== "app"
        ? undefined
        : pathname === "/export.html" || pathname === "/export.js"
          ? join(job.pageDir, pathname)
          : pathname === "/take/frames.webm"
            ? join(job.takeDir, "frames.webm")
            : pathname === "/background.jpg"
              ? job.backgroundFile
              : undefined
    if (file === undefined) return new Response("not found", { status: 404 })
    const ext = file.slice(file.lastIndexOf("."))
    return new Response(readFileSync(file), { headers: { "content-type": types[ext] ?? "" } })
  })
  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } })
  // Module scripts run before the load event loadURL waits for: the function exists now, or the
  // page failed to load (no endless wait).
  await win.loadURL("kiframe://app/export.html")
  const ready = (await win.webContents.executeJavaScript(
    'typeof window.kiframeExport === "function"',
  )) as boolean
  if (!ready) throw new Error("the export page didn't load (see the page's console)")
  const args: PageExportArgs = {
    ...job.args,
    videoUrl: "kiframe://app/take/frames.webm",
    ...(job.backgroundFile !== undefined && { backgroundUrl: "kiframe://app/background.jpg" }),
  }
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
