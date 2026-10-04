# Performance and resources

What the desktop app costs while it works, and what it leaves behind. Measured on the built app
(an Apple silicon Mac, Electron 44, Playwright's headless Chromium), the model scripted unless
said: the numbers are the app's own, not a model's latency. Re-run them after a change to the
runtime, the recorder, the main process or the renderer.

## How to measure

Build first (`pnpm --filter @kiframe/desktop build`). Each script writes to `.kiframe-local/perf/`.

| Script | What it does |
| --- | --- |
| `node scripts/perf/soak.ts --cycles 40 --switch-every 5` | N demo cycles (save → replay → record → preview played), two projects switched every 5; samples every process of the app every 500 ms, heaps after a forced GC each cycle; after quitting, any process or temp folder left |
| `node scripts/perf/stress.ts` | A recording stopped midway, a recording that fails, the project closed, the app quit while recording: how long each takes, ffmpeg runs, what's left |
| `node scripts/perf/quit-encode.ts` | The app quit (as Cmd-Q) while ffmpeg encodes: is the encoder left running |
| `node scripts/perf/latency.ts` | The window's request round trip (every 100 ms) and its frame gaps, idle and while recording |
| `node scripts/perf/watch.ts` + `node scripts/real-apps/drive.ts --app minmux` | A real-app run with the real model, its process tree sampled every second |

## Results (2026-10-04)

**No leak.** Over 40 demo cycles and 7 project switches:

| | First cycle | Cycle 20 | Cycle 40 | Trend (last 20) |
| --- | --- | --- | --- | --- |
| Main process heap (after GC) | 40.8 MB | 43.4 MB | 43.7 MB | +0.016 MB a cycle (the chat's history) |
| Window heap (after GC) | 8.5 MB | 9.7 MB | 9.9 MB | +0.006 MB a cycle |
| Processes of the app | 7 | 7 | 7 | flat (3 of them the agent's browser) |
| Whole process tree | 760 MB | 661 MB | 662 MB | flat |
| A cycle (save, replay, 7-step recording) | 10.9 s | 10.4 s | 10.4 s | flat |
| Preview ready | 27 ms | 18 ms | 28 ms | flat |

116 processes were started over the run (a browser context per replay and recording) and every
one ended; after quitting, **no process and no temp folder** was left. Launch to window: 0.7 s;
quit: 0.2 s.

**Stop, failure, close, quit** (after the fixes below):

| Path | Result |
| --- | --- |
| Stop while recording | stopped in 0.3–0.8 s (where in a step it lands), nothing encoded |
| A recording that fails | no encode (the failure itself waits for its step's timeout) |
| Project closed | the agent's browser closed (0 processes; launched again by the next project) |
| Quit while recording | 0.4 s, nothing left after 0.5 s, 5 s, 15 s |
| Quit while ffmpeg encodes | ffmpeg gone within 0.5 s (not orphaned) |

**Responsiveness while recording** (scripted, local page, two runs): the window's request round trip p95 1.9–2.9 ms, worst 17–24 ms (idle under 2 ms); no frame gap over 11 ms.

**A real app** (minmux.dev, the real model, 7 minutes, $0.02): the process tree's median 1.06 GB,
peak 1.28 GB, at most 9 processes; the main process peaks at 93% CPU while recording (Playwright
runs in it: see the backlog); nothing left after quitting. ffmpeg's encode peaks near 400 MB.

## Fixed by this audit

- The chat pushed the whole window up as it grew (`scrollIntoView` scrolled the window's root,
  its overflow hidden: the title bar out of view, a blank strip under the composer). Only the log
  scrolls now. It follows the newest item while it's at its end (a message filled in, the log
  resized when the composer comes back after a run), and stays where the user scrolled to read
  until they send a message: only the user's own scrolling (a wheel, a key, a scrollbar drag)
  takes it away from the end.
- A stopped or failed recording was encoded (ffmpeg, seconds of CPU) and its video dropped at once
  by the take store: not encoded now (`encodeFailed: false`).
- The agent's browser outlived its project (about 190 MB, 3 processes): closed with the project,
  and a quit waits for a close under way.

The rest is in BACKLOG ("Performance and resources").
