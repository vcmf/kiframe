// Stress paths of the built desktop app, the model scripted: a recording stopped midway, a
// recording that fails, the project closed, and the app quit while recording. Samples the app's
// process tree every 100 ms (ffmpeg encoders, the agent's browser) and says how long each took
// and what was left running. Writes stress.json.
//
// Usage: node scripts/perf/stress.ts   (build the app first)
import { createServer } from "node:http"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  call,
  launchScripted,
  newProject,
  openProject,
  processes,
  quit,
  role,
  root,
  send,
  sleep,
  stillAlive,
  treeOf,
} from "./lib.ts"

const out = join(root, ".kiframe-local", "perf", `stress-${Date.now()}`)
mkdirSync(out, { recursive: true })
const log = (line: string) => console.log(`[stress] ${line}`)

// /flaky has its button on the replay (odd visits) and not on the recording (even ones).
let flaky = 0
const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" })
  if (req.url === "/flaky") {
    flaky += 1
    const button = flaky % 2 === 1 ? "<button>Go</button>" : ""
    res.end(`<!doctype html><title>Flaky</title><h1>Flaky</h1>${button}`)
    return
  }
  res.end(`<!doctype html><title>Home</title><h1>Home</h1><button>Go</button><p>Text</p>`)
})
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`

const long = (path: string) => `version: 1
setup: [{ action: goto, url: ${path} }]
steps:
  - { id: a, action: pause, ms: 3000 }
  - { id: b, action: click, target: { by: role, role: button, name: Go } }
  - { id: c, action: pause, ms: 3000 }
  - { id: d, action: pause, ms: 3000 }
  - { id: e, action: pause, ms: 3000 }
`
const turns = [
  // 1. Stopped while recording (no turn after: the run ends there).
  call("s1", "save_scene", { id: "tour", title: "Tour", yaml: long("/") }),
  call("r1", "record_scene", { id: "tour" }),
  // 2. A recording that fails (the button gone when filmed).
  call("s2", "save_scene", { id: "flaky", title: "Flaky", yaml: long("/flaky") }),
  call("r2", "record_scene", { id: "flaky" }),
  { kind: "text", text: "Flaky done." },
  // 4. Quit while recording.
  call("s3", "save_scene", { id: "tour", title: "Tour", yaml: long("/") }),
  call("r3", "record_scene", { id: "tour" }),
]
const project = newProject("stress", "Stress", url)
const l = await launchScripted({ turns })
const { page, mainPid } = l

// Every process ever under the app, and the ffmpeg runs seen per phase.
const seen = new Map<number, string>()
let phase = "start"
const ffmpegBy = new Map<string, Set<number>>()
const sampler = setInterval(() => {
  for (const p of treeOf(processes(), mainPid)) {
    seen.set(p.pid, p.command.slice(0, 140))
    if (role(p, mainPid) === "ffmpeg") {
      ffmpegBy.set(phase, (ffmpegBy.get(phase) ?? new Set()).add(p.pid))
    }
  }
}, 100)
const count = (prefix: string) =>
  treeOf(processes(), mainPid).filter((p) => role(p, mainPid).startsWith(prefix)).length
/** Until record_scene is running (the last tool group says 2 steps, running). */
const untilRecording = () =>
  page.waitForFunction(
    () =>
      [...document.querySelectorAll(".tool-group-head")]
        .at(-1)
        ?.textContent?.includes("2 steps · running") ?? false,
    undefined,
    { timeout: 60_000 },
  )
const report: Record<string, unknown> = {}

try {
  await openProject(l, project, "Stress")

  // 1. Stop while recording.
  phase = "stop"
  await send(page, "Record the tour")
  await untilRecording()
  await sleep(3000)
  const stopAt = Date.now()
  await page.getByRole("button", { name: "Stop" }).click()
  await page.getByText("Stopped. Nothing more ran.").waitFor({ timeout: 120_000 })
  report.stop = {
    stopToStoppedMs: Date.now() - stopAt,
    ffmpegRuns: ffmpegBy.get("stop")?.size ?? 0,
    ffmpegAfter: count("ffmpeg"),
  }
  log(`stop: ${JSON.stringify(report.stop)}`)

  // 2. A recording that fails.
  phase = "fail"
  const failAt = Date.now()
  await send(page, "Record the flaky scene")
  await page.getByText("Flaky done.").waitFor({ timeout: 180_000 })
  report.fail = {
    turnMs: Date.now() - failAt,
    ffmpegRuns: ffmpegBy.get("fail")?.size ?? 0,
    ffmpegAfter: count("ffmpeg"),
  }
  log(`fail: ${JSON.stringify(report.fail)}`)

  // 3. The project closed: what of the agent's browser stays.
  phase = "close"
  const agentOpen = count("agent")
  await page.getByRole("button", { name: /Stress/ }).click()
  await page.getByRole("menuitem", { name: "Close project" }).click()
  await page.getByRole("heading", { name: "Start a demo" }).waitFor()
  await sleep(3000)
  report.close = { agentProcessesOpen: agentOpen, agentProcessesAfterClose: count("agent") }
  log(`close: ${JSON.stringify(report.close)}`)

  // 4. Quit while recording.
  phase = "quit"
  await openProject(l, project, "Stress")
  await send(page, "Record the tour again")
  await untilRecording()
  await sleep(3000)
} catch (e) {
  report.error = e instanceof Error ? e.message.split("\n")[0] : String(e)
  log(`stopped early: ${String(report.error)}`)
} finally {
  clearInterval(sampler)
}
const quitMs = await quit(l).catch(() => -1)
const lingering: Record<string, string[]> = {}
let waited = 0
for (const at of [500, 5000, 15000]) {
  await sleep(at - waited)
  waited = at
  lingering[`${at}ms`] = stillAlive(seen)
}
report.quit = { quitMs, lingering }
log(
  `quit: ${quitMs} ms; still alive at 0.5s/5s/15s: ${Object.values(lingering)
    .map((x) => x.length)
    .join("/")}`,
)
server.close()
writeFileSync(join(out, "stress.json"), JSON.stringify(report, null, 2))
log(`written to ${out}`)
if (report.error !== undefined) process.exitCode = 1
