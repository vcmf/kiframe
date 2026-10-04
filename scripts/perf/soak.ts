// Soak test of the built desktop app: N demo cycles (save a scene, its replay, its recording, its
// preview played), the model scripted (no network, no key spent), against a local page. Samples
// the app's whole process tree every 500 ms (each process's memory and CPU, by role), the main and
// window heaps after a forced GC once per cycle, and after quitting looks for any process or temp
// folder left behind. Writes samples.csv, cycles.csv and summary.json.
//
// Usage: node scripts/perf/soak.ts [--cycles 20] [--switch-every 5]
// Build the app first (pnpm --filter @kiframe/desktop build).
import { mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import {
  call,
  every,
  launchScripted,
  newProject,
  openProject,
  quit,
  removeTemp,
  root,
  sampleTree,
  send,
  serve,
  sleep,
  stillAlive,
} from "./lib.ts"

const { values } = parseArgs({
  options: {
    cycles: { type: "string", default: "20" },
    "switch-every": { type: "string", default: "5" },
  },
})
const CYCLES = Number(values.cycles)
const SWITCH_EVERY = Number(values["switch-every"])
const out = join(root, ".kiframe-local", "perf", `soak-${Date.now()}`)
mkdirSync(out, { recursive: true })
const log = (line: string) => console.log(`[soak] ${line}`)

// A small app to film: a search box, a long list, a second page.
const items = Array.from({ length: 60 }, (_, i) => `<li>Invoice #${1000 + i}</li>`).join("")
const pages: Record<string, string> = {
  "/": `<!doctype html><title>Acme</title><h1>Acme Billing</h1>
    <label>Search <input aria-label="Search"></label><button>Search</button>
    <a href="/about">About</a><ul>${items}</ul>`,
  "/about": `<!doctype html><title>About</title><h1>About Acme</h1><p>We bill.</p>`,
}
const { url, close } = await serve((path) => pages[path])

const SCENE = `version: 1
setup: [{ action: goto, url: / }]
steps:
  - { id: look, action: pause, ms: 600 }
  - { id: search, action: type, target: { by: label, name: Search }, value: invoices }
  - { id: run, action: click, target: { by: role, role: button, name: Search } }
  - { id: down, action: scroll, by: { y: 900 } }
  - { id: up, action: scroll, by: { y: -900 } }
  - { id: about, action: click, target: { by: role, role: link, name: About } }
  - { id: read, action: pause, ms: 600 }
`
const turns = Array.from({ length: CYCLES }, (_, i) => [
  call(`s${i}`, "save_scene", { id: "tour", title: "Tour", notes: "A tour", yaml: SCENE }),
  call(`r${i}`, "record_scene", { id: "tour" }),
  { kind: "text", text: `Cycle ${i} done.` },
]).flat()
const projects = [newProject("soak-a", "Soak a", url), newProject("soak-b", "Soak b", url)]
const names = ["Soak a", "Soak b"]

/** Temp folders Playwright or the recorder make (left behind: a leak). */
const tempEntries = () =>
  readdirSync(tmpdir()).filter((n) => /^(playwright|kiframe-take|\.kiframe)/.test(n))
const tempBefore = new Set(tempEntries())

const started = Date.now()
const l = await launchScripted({ turns, jsFlags: "--expose-gc" })
const { app, page, mainPid } = l
const launchedMs = Date.now() - started

// Every process of the app ever seen (checked after quitting), and samples.
const seen = new Map<number, string>()
let phase = "start"
const samples: string[] = ["t_s,phase,role,count,rss_mb,cpu"]
const sample = async () => {
  const t = ((Date.now() - started) / 1000).toFixed(1)
  const { byRole } = await sampleTree(mainPid, seen)
  for (const [r, s] of byRole) {
    samples.push(`${t},${phase},${r},${s.count},${s.rss.toFixed(1)},${s.cpu.toFixed(1)}`)
  }
  return byRole
}
const sampleErrors: string[] = []
const stopSampling = every(500, sample, sampleErrors)

/** Main and window heaps after a forced GC (MB). */
async function heaps() {
  const main = await app.evaluate(() => {
    ;(globalThis as { gc?: () => void }).gc?.()
    const m = process.memoryUsage()
    return { heap: m.heapUsed / 2 ** 20, rss: m.rss / 2 ** 20, external: m.external / 2 ** 20 }
  })
  const win = await page.evaluate(() => {
    ;(globalThis as { gc?: () => void }).gc?.()
    const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
    return {
      heap: (m?.usedJSHeapSize ?? 0) / 2 ** 20,
      nodes: document.getElementsByTagName("*").length,
      canvases: document.getElementsByTagName("canvas").length,
    }
  })
  return { main, win }
}

const cycles: string[] = [
  "cycle,project,turn_ms,preview_ready_ms,main_heap_mb,main_rss_mb,main_external_mb,win_heap_mb,dom_nodes,canvases,procs,agent_procs,tree_rss_mb",
]
const failures: string[] = []
let current = 0
let base: Awaited<ReturnType<typeof heaps>> | undefined
let readyMs = 0
try {
  await openProject(l, projects[current]!, names[current]!)
  readyMs = Date.now() - started
  await sleep(1500)
  base = await heaps()
  log(
    `launched in ${launchedMs} ms, ready ${readyMs} ms; main heap ${base.main.heap.toFixed(1)} MB`,
  )
  for (let i = 0; i < CYCLES; i++) {
    if (i > 0 && SWITCH_EVERY > 0 && i % SWITCH_EVERY === 0) {
      phase = "switch"
      const from = names[current]!
      current = 1 - current
      await openProject(l, projects[current]!, names[current]!, from)
    }
    phase = "turn"
    const t0 = Date.now()
    await send(page, `Make and record the tour (cycle ${i})`)
    try {
      await page.getByText(`Cycle ${i} done.`).waitFor({ timeout: 180_000 })
    } catch {
      failures.push(`cycle ${i}: no answer in 3 min`)
      break
    }
    const turnMs = Date.now() - t0
    // The preview of the take just recorded, played for a while.
    phase = "preview"
    const t1 = Date.now()
    let previewMs = -1
    try {
      await page
        .getByRole("region", { name: "Scenes" })
        .getByRole("button", { name: /Tour/ })
        .click()
      await page.locator('canvas[aria-label="Preview of Tour"]').waitFor({ timeout: 30_000 })
      await page.getByRole("button", { name: "Play" }).waitFor({ timeout: 30_000 })
      previewMs = Date.now() - t1
      await page.getByRole("button", { name: "Play" }).click()
      await sleep(4000)
      const pause = page.getByRole("button", { name: "Pause" })
      if (await pause.isVisible().catch(() => false)) await pause.click()
    } catch (e) {
      failures.push(
        `cycle ${i}: preview ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`,
      )
    }
    phase = "idle"
    await sleep(1500)
    const h = await heaps()
    // Read, not a sample of its own (the sampler writes the rows: none twice).
    const { byRole: by } = await sampleTree(mainPid, seen)
    const procs = [...by.values()].reduce((s, v) => s + v.count, 0)
    const agent = [...by.entries()]
      .filter(([r]) => r.startsWith("agent"))
      .reduce((s, [, v]) => s + v.count, 0)
    const rss = [...by.values()].reduce((s, v) => s + v.rss, 0)
    cycles.push(
      [
        i,
        current,
        turnMs,
        previewMs,
        h.main.heap.toFixed(1),
        h.main.rss.toFixed(1),
        h.main.external.toFixed(1),
        h.win.heap.toFixed(1),
        h.win.nodes,
        h.win.canvases,
        procs,
        agent,
        rss.toFixed(0),
      ].join(","),
    )
    log(
      `cycle ${i}: turn ${turnMs} ms, preview ${previewMs} ms, main heap ${h.main.heap.toFixed(1)} MB, ` +
        `window heap ${h.win.heap.toFixed(1)} MB, ${procs} processes (${agent} agent), ${rss.toFixed(0)} MB`,
    )
  }
} catch (e) {
  failures.push(`stopped: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`)
} finally {
  stopSampling()
  failures.push(...sampleErrors)
}

// Quit as a user would, then look for anything left.
phase = "quit"
const quitMs = await quit(l).catch((e: unknown) => {
  failures.push(`quit: ${String(e)}`)
  return -1
})
await sleep(3000)
const leftover = await stillAlive(seen)
const tempLeft = tempEntries().filter((n) => !tempBefore.has(n))
close()
removeTemp()

writeFileSync(join(out, "samples.csv"), samples.join("\n") + "\n")
writeFileSync(join(out, "cycles.csv"), cycles.join("\n") + "\n")
const summary = {
  cycles: CYCLES,
  launchedMs,
  readyMs,
  quitMs,
  baseline: base,
  failures,
  leftoverProcesses: leftover,
  leftoverTemp: tempLeft,
  processesSeen: seen.size,
}
writeFileSync(join(out, "summary.json"), JSON.stringify(summary, null, 2))
log(`quit in ${quitMs} ms; leftover processes: ${leftover.length}; temp left: ${tempLeft.length}`)
log(`failures: ${failures.length}; written to ${out}`)
if (failures.length > 0 || leftover.length > 0) process.exitCode = 1
