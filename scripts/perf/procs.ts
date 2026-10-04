// The process table and an app's process tree by role: no side effects (the desktop e2e suite
// counts the agent's browser with it).
import { execFile } from "node:child_process"
import { promisify } from "node:util"

export interface Proc {
  pid: number
  ppid: number
  rssKb: number
  cpu: number
  command: string
}

const run = promisify(execFile)

/** Every process on the machine (read without blocking the script: its timings stay its own). */
export async function processes(): Promise<Proc[]> {
  const { stdout } = await run("ps", ["-axo", "pid=,ppid=,rss=,pcpu=,command="], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
  return stdout
    .split("\n")
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ pid: +m[1]!, ppid: +m[2]!, rssKb: +m[3]!, cpu: +m[4]!, command: m[5]! }))
}

/** A process and everything under it. */
export function treeOf(all: Proc[], rootPid: number): Proc[] {
  const kids = new Map<number, Proc[]>()
  for (const p of all) {
    const siblings = kids.get(p.ppid)
    if (siblings === undefined) kids.set(p.ppid, [p])
    else siblings.push(p)
  }
  const list = all.filter((p) => p.pid === rootPid)
  const walk = (pid: number) => {
    for (const k of kids.get(pid) ?? []) {
      list.push(k)
      walk(k.pid)
    }
  }
  walk(rootPid)
  return list
}

/** What a process of the app is: its main process, its helpers, the agent's browser, ffmpeg. */
export function role(p: Proc, mainPid: number): string {
  const c = p.command
  if (p.pid === mainPid) return "app-main"
  if (/ffmpeg/.test(c)) return "ffmpeg"
  if (/ms-playwright|chrome-headless-shell|Chromium/i.test(c)) {
    if (/--type=renderer/.test(c)) return "agent-tab"
    if (/--type=gpu/.test(c)) return "agent-gpu"
    if (/--type=/.test(c)) return "agent-other"
    return "agent-browser"
  }
  if (/--type=renderer/.test(c)) return "app-renderer"
  if (/--type=gpu/.test(c)) return "app-gpu"
  if (/--type=utility/.test(c)) return "app-utility"
  if (/--type=/.test(c)) return "app-other"
  return "other"
}
