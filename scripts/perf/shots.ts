// Screenshots of the built desktop app's layout, the model scripted: each state (the start, an
// empty project, a run under way, a recorded scene in the chat, the strip, the preview, the live
// app) at each window size (the minimum, a laptop, a desktop, full screen). For checking padding,
// overflow and what's cut off. Writes PNGs to .kiframe-local/shots/<time>/.
//
// Usage: node scripts/perf/shots.ts   (build the app first)
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import {
  call,
  launchScripted,
  newProject,
  openProject,
  quit,
  root,
  send,
  serve,
  sleep,
} from "./lib.ts"

const out = join(root, ".kiframe-local", "shots", `${Date.now()}`)
mkdirSync(out, { recursive: true })
const items = Array.from({ length: 40 }, (_, i) => `<li>Invoice #${1000 + i}</li>`).join("")
const { url, close } = await serve(
  () =>
    `<!doctype html><title>Acme</title><h1>Acme Billing</h1><button>Search</button><ul>${items}</ul>`,
)
const scene = `version: 1
setup: [{ action: goto, url: / }]
steps:
${["a", "b", "c", "d", "e"].map((id) => `  - { id: ${id}, action: pause, ms: 400 }`).join("\n")}
`
const l = await launchScripted({
  turns: [
    call("s1", "save_scene", { id: "tour", title: "A short tour", yaml: scene }),
    call("r1", "record_scene", { id: "tour" }),
    { kind: "text", text: "Done: **A short tour** is saved and recorded (5 steps)." },
    call("p1", "run_step", { scene: "tour", step: { id: "wait", action: "pause", ms: 8000 } }),
    { kind: "text", text: "Waited." },
  ],
})
const { app, page } = l
// The window's sizes on this screen: its minimum, a small laptop's, and as large as the screen's
// work area allows (larger is clamped by the OS), then full screen.
const workArea = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workAreaSize)
const sizes: [string, number, number][] = [
  ["min-1024x680", 1024, 680],
  ["small-1280x800", 1280, 800],
  [`max-${workArea.width}x${workArea.height}`, workArea.width, workArea.height],
]
/** The layout's rules, checked in each shot: what breaks one is said (and the run fails). */
const broken: string[] = []
const check = async (where: string) => {
  const found = await page.evaluate(() => {
    const out: string[] = []
    const bottom = window.innerHeight
    for (const sel of [".strip", ".composer-wrap", ".scene-card"]) {
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect()
        if (r.bottom > bottom + 1) out.push(`${sel} cut off (${Math.round(r.bottom - bottom)}px)`)
      }
    }
    if ((document.scrollingElement?.scrollTop ?? 0) !== 0) out.push("the window's root scrolled")
    const live = document.querySelector('[role="tab"][aria-selected="true"]')?.textContent ?? ""
    const player = document.querySelector(".player")
    if (/Live/.test(live) && player !== null && player.getBoundingClientRect().height > 0) {
      out.push("the preview's player shows on the Live tab")
    }
    return out
  })
  for (const f of found) broken.push(`${where}: ${f}`)
}
const shot = async (state: string) => {
  for (const [name, w, h] of sizes) {
    await app.evaluate(
      ({ BrowserWindow }, [width, height]) => {
        const win = BrowserWindow.getAllWindows()[0]
        win?.setFullScreen(false)
        win?.setSize(width, height)
      },
      [w, h] as const,
    )
    await sleep(500)
    await page.screenshot({ path: join(out, `${state}-${name}.png`) })
    await check(`${state} ${name}`)
  }
  // Full screen: the window over the whole screen, menu bar hidden (macOS's simple full screen:
  // the same layout as the animated one, which a window driven by a test may never enter).
  const full = (on: boolean) =>
    app.evaluate(({ BrowserWindow }, yes) => {
      BrowserWindow.getAllWindows()[0]?.setSimpleFullScreen(yes)
    }, on)
  await full(true)
  await sleep(800)
  await page.screenshot({ path: join(out, `${state}-fullscreen.png`) })
  await check(`${state} fullscreen`)
  await full(false)
  // Back to a size that fits the screen for the next step.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 800))
  await sleep(400)
}
try {
  await shot("1-start")
  await openProject(l, newProject("acme", "Acme Billing", url), "Acme Billing")
  await shot("2-empty-project")
  await send(page, "Make a short tour of the app")
  await page.getByText("Done:").waitFor({ timeout: 120_000 })
  await shot("3-chat-and-strip")
  await page.getByRole("region", { name: "Scenes" }).getByRole("button").first().click()
  await sleep(1500)
  await shot("4-preview")
  await send(page, "Wait a moment")
  await page.getByRole("button", { name: "Stop" }).waitFor({ timeout: 30_000 })
  await shot("5-running")
  await page.getByText("Waited.").waitFor({ timeout: 60_000 })
  await page
    .getByRole("tab", { name: /Live app/ })
    .click()
    .catch(() => undefined)
  await shot("6-live")
} finally {
  await quit(l).catch(() => undefined)
  close()
}
console.log(`[shots] written to ${out}`)
for (const b of broken) console.log(`[shots] BROKEN ${b}`)
if (broken.length > 0) process.exitCode = 1
