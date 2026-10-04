// Quits the built desktop app (as Cmd-Q does) while ffmpeg encodes a recording, the model
// scripted, then says whether the encoder or anything else of the app is still running.
// Usage: node scripts/perf/quit-encode.ts   (build the app first)
import {
  call,
  launchScripted,
  newProject,
  openProject,
  quit,
  removeTemp,
  role,
  sampleTree,
  send,
  serve,
  sleep,
  stillAlive,
} from "./lib.ts"

const log = (line: string) => console.log(`[quit-encode] ${line}`)
const { url, close } = await serve(
  () => `<!doctype html><title>Home</title><h1>Home</h1><button>Go</button>`,
)
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
    for (const p of (await sampleTree(l.mainPid, seen)).procs) {
      if (role(p, l.mainPid) === "ffmpeg") ffmpeg = p.pid
    }
    if (ffmpeg === undefined) await sleep(50)
  }
  log(`ffmpeg ${ffmpeg} encoding; quitting`)
} finally {
  log(`quit in ${await quit(l)} ms`)
  close()
}
let waited = 0
for (const at of [500, 5000, 15000]) {
  await sleep(at - waited)
  waited = at
  const left = await stillAlive(seen)
  log(`after ${at} ms: ${left.length === 0 ? "nothing left" : left.join("; ")}`)
  if (at === 15000 && left.length > 0) process.exitCode = 1
}
removeTemp()
