// Quits the built desktop app (as Cmd-Q does) while ffmpeg encodes a recording, the model
// scripted, then says whether the encoder or anything else of the app is still running.
// Usage: node scripts/perf/quit-encode.ts   (build the app first)
import { createServer } from "node:http"
import {
  call,
  launchScripted,
  newProject,
  openProject,
  processes,
  quit,
  role,
  send,
  sleep,
  stillAlive,
  treeOf,
} from "./lib.ts"

const log = (line: string) => console.log(`[quit-encode] ${line}`)
const server = createServer((_q, res) => {
  res.writeHead(200, { "content-type": "text/html" })
  res.end(`<!doctype html><title>Home</title><h1>Home</h1><button>Go</button>`)
})
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
// A long scene: a long encode to quit during.
const steps = Array.from({ length: 8 }, (_, i) => `  - { id: p${i}, action: pause, ms: 2500 }`)
const yaml = `version: 1\nsetup: [{ action: goto, url: / }]\nsteps:\n${steps.join("\n")}\n`
const project = newProject("quit", "Quit", url)
const l = await launchScripted({
  turns: [
    call("s", "save_scene", { id: "tour", title: "Tour", yaml }),
    call("r", "record_scene", { id: "tour" }),
  ],
})
const seen = new Map<number, string>()
let ffmpeg: number | undefined
try {
  await openProject(l, project, "Quit")
  await send(l.page, "Record it")
  const started = Date.now()
  while (ffmpeg === undefined) {
    if (Date.now() - started > 120_000) throw new Error("no ffmpeg seen in 2 min")
    for (const p of treeOf(processes(), l.mainPid)) {
      seen.set(p.pid, p.command.slice(0, 120))
      if (role(p, l.mainPid) === "ffmpeg") ffmpeg = p.pid
    }
    if (ffmpeg === undefined) await sleep(50)
  }
  log(`ffmpeg ${ffmpeg} encoding; quitting`)
} finally {
  log(`quit in ${await quit(l)} ms`)
  server.close()
}
let waited = 0
for (const at of [500, 5000, 15000]) {
  await sleep(at - waited)
  waited = at
  const left = stillAlive(seen)
  log(`after ${at} ms: ${left.length === 0 ? "nothing left" : left.join("; ")}`)
  if (at === 15000 && left.length > 0) process.exitCode = 1
}
