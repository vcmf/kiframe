// Watches the desktop app's process tree while something else drives it (a real-app run): waits
// for the app's main process, samples every process under it every second (memory and CPU, by
// role), and after it exits looks for any process of it still alive. Writes watch.csv and
// watch.json.
//
// Usage: node scripts/perf/watch.ts [--out dir] [--wait-minutes 10]
// (then start the run, e.g. scripts/real-apps/drive.ts)
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { appDir, type Proc, processes, role, root, sleep, stillAlive, treeOf } from "./lib.ts"

const { values } = parseArgs({
  options: { out: { type: "string" }, "wait-minutes": { type: "string", default: "10" } },
})
const out = values.out ?? join(root, ".kiframe-local", "perf", `watch-${Date.now()}`)
mkdirSync(out, { recursive: true })
const isMain = (p: Proc) =>
  /Electron/.test(p.command) && p.command.includes(appDir) && !/--type=/.test(p.command)

const waitUntil = Date.now() + Number(values["wait-minutes"]) * 60_000
let main: Proc | undefined
while (main === undefined) {
  main = processes().find(isMain)
  if (main !== undefined) break
  if (Date.now() > waitUntil) throw new Error("the app didn't start")
  await sleep(500)
}
const mainPid = main.pid
const started = Date.now()
console.log(`[watch] app main ${mainPid}`)
const seen = new Map<number, string>()
const rows = ["t_s,role,count,rss_mb,cpu"]
let peak = { rss: 0, procs: 0, agentTabs: 0 }
for (;;) {
  const all = processes()
  if (!all.some((p) => p.pid === mainPid)) break
  const t = ((Date.now() - started) / 1000).toFixed(0)
  const by = new Map<string, { count: number; rss: number; cpu: number }>()
  for (const p of treeOf(all, mainPid)) {
    const r = role(p, mainPid)
    seen.set(p.pid, `${r} ${p.command.slice(0, 120)}`)
    const s = by.get(r) ?? { count: 0, rss: 0, cpu: 0 }
    by.set(r, { count: s.count + 1, rss: s.rss + p.rssKb / 1024, cpu: s.cpu + p.cpu })
  }
  for (const [r, s] of by) rows.push(`${t},${r},${s.count},${s.rss.toFixed(1)},${s.cpu.toFixed(1)}`)
  const rss = [...by.values()].reduce((s, v) => s + v.rss, 0)
  const procs = [...by.values()].reduce((s, v) => s + v.count, 0)
  peak = {
    rss: Math.max(peak.rss, rss),
    procs: Math.max(peak.procs, procs),
    agentTabs: Math.max(peak.agentTabs, by.get("agent-tab")?.count ?? 0),
  }
  await sleep(1000)
}
await sleep(3000)
const leftover = stillAlive(seen)
writeFileSync(join(out, "watch.csv"), rows.join("\n") + "\n")
const summary = {
  seconds: (Date.now() - started) / 1000,
  peakTreeRssMb: Math.round(peak.rss),
  peakProcesses: peak.procs,
  peakAgentTabs: peak.agentTabs,
  processesSeen: seen.size,
  leftover,
}
writeFileSync(join(out, "watch.json"), JSON.stringify(summary, null, 2))
console.log(`[watch] ${JSON.stringify(summary)}`)
if (leftover.length > 0) process.exitCode = 1
