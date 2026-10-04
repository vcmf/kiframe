// How the built desktop app answers its window while it records (the model scripted): a cheap
// request round trip (chat:state) every 100 ms and the window's frame gaps, idle and then during a
// save, replay and recording. Build the app first. Usage: node scripts/perf/latency.ts
import {
  call,
  launchScripted,
  newProject,
  openProject,
  quit,
  removeTemp,
  send,
  serve,
  sleep,
  stats,
} from "./lib.ts"

const log = (line: string) => console.log(`[latency] ${line}`)
const items = Array.from({ length: 80 }, (_, i) => `<li>Row ${i}</li>`).join("")
const { url, close } = await serve(
  () => `<!doctype html><title>Home</title><h1>Home</h1><button>Go</button><ul>${items}</ul>`,
)
const yaml = `version: 1
setup: [{ action: goto, url: / }]
steps:
  - { id: a, action: pause, ms: 1500 }
  - { id: b, action: scroll, by: { y: 1200 } }
  - { id: c, action: scroll, by: { y: -1200 } }
  - { id: d, action: click, target: { by: role, role: button, name: Go } }
  - { id: e, action: scroll, by: { y: 1200 } }
  - { id: f, action: pause, ms: 1500 }
`
const project = newProject("lat", "Latency", url)
const l = await launchScripted({
  turns: [
    call("s", "save_scene", { id: "tour", title: "Tour", yaml }),
    call("r", "record_scene", { id: "tour" }),
    { kind: "text", text: "Recorded." },
  ],
})
const { page } = l
type Probe = { phase: string; rtt: [string, number][]; gaps: [string, number][] }
try {
  await openProject(l, project, "Latency")
  // In the window: a round trip every 100 ms, and every frame gap, tagged by phase.
  await page.evaluate(() => {
    const w = window as unknown as {
      probe: Probe
      kiframe: { invoke: (c: string) => Promise<unknown> }
    }
    w.probe = { phase: "idle", rtt: [], gaps: [] }
    const tick = async () => {
      const t = performance.now()
      await w.kiframe.invoke("chat:state")
      w.probe.rtt.push([w.probe.phase, performance.now() - t])
      setTimeout(() => void tick(), 100)
    }
    void tick()
    let last = performance.now()
    const frame = (now: number) => {
      w.probe.gaps.push([w.probe.phase, now - last])
      last = now
      requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  })
  const setPhase = (p: string) =>
    page.evaluate((x) => {
      ;(window as unknown as { probe: Probe }).probe.phase = x
    }, p)
  await sleep(5000)
  await setPhase("recording")
  await send(page, "Record it")
  await page.getByText("Recorded.").waitFor({ timeout: 180_000 })
  await setPhase("after")
  await sleep(3000)
  const probe = await page.evaluate(() => (window as unknown as { probe: Probe }).probe)
  for (const phase of ["idle", "recording", "after"]) {
    const rtt = probe.rtt.filter(([p]) => p === phase).map(([, v]) => v)
    const gaps = probe.gaps.filter(([p]) => p === phase).map(([, v]) => v)
    // No frames (a hidden window throttles them): said, not a worst of -Infinity.
    const frames =
      gaps.length === 0
        ? "no frames (window hidden?)"
        : `frames ${gaps.length}, gaps >50 ms ${gaps.filter((g) => g > 50).length}, ` +
          `>100 ms ${gaps.filter((g) => g > 100).length}, worst ${Math.max(...gaps).toFixed(0)} ms`
    log(`${phase}: ipc ms ${JSON.stringify(stats(rtt))}; ${frames}`)
  }
} finally {
  await quit(l).catch(() => undefined)
  close()
  removeTemp()
}
