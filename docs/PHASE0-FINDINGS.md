# Phase 0 findings

> Running log of what the spike learns. Becomes `PHASE0-REPORT.md` at the end of Phase 0
> (IMPLEMENTATION-PLAN §2): results against the exit criteria, failure catalogue, re-estimates.

## F1. Chromium screencast frames are at CSS resolution, not device pixels (2026-09-27)

**Context:** APPROACHES §6 decided "capture through `page.screencast` / CDP at deviceScaleFactor 2"
so that camera zooms stay sharp (a 1440×900 viewport would give 2880×1800 frames).

**Measured** (Playwright 1.63, Chromium 153, macOS, headless shell and new headless):

| Method | Frame size (1440×900 viewport, DPR 2) | Rate |
|---|---|---|
| `page.screencast.start({ size: 2880×1800 })` | **1440×900** | ~60 fps |
| CDP `Page.startScreencast({ maxWidth: 2880 })` | **1440×900** | ~60 fps |
| CDP screencast + `Emulation.setDeviceMetricsOverride({ scale: 2 })` | **1440×900** | ~60 fps |
| CDP `Page.captureScreenshot` loop | **1440×900** | ~30 fps |
| `page.screenshot({ scale: "device" })` loop | **2880×1800** | ~11 fps (JPEG), ~6.5 (PNG) |

Frame `timestamp`s from `page.screencast` are epoch milliseconds (fractional), the same clock as
`Date.now()`: events and frames can share one clock directly.

**Decision for now:** P0-5 records at CSS resolution, 60 fps (smooth). The zoom quality question
moves to P0-7: if a 1.5–2× zoom from 1440×900 isn't acceptable on video, spike one of:
- virtual-time frame stepping (`HeadlessExperimental.beginFrame` with screenshots, deterministic
  mode): perfect frames at device resolution, slower than real time;
- headed capture on a Retina screen (the window's backing scale may give device-pixel frames);
- a larger CSS viewport with the output scaled down (changes the app's responsive layout).

**Doc impact if confirmed:** APPROACHES §0 "Capture" and §6 ("DPR 2 capture", zoom cap vs
source resolution) must be revised.

## F2. Headed capture on a Retina screen gives device-pixel frames; 2.5× needs them (2026-09-27)

**Test:** app.dim0.net, `examples/dim0/new-board.yaml` (a forced 2.5× zoom on the toolbar's Note
button), exported to 1080p MP4 through the Electron exporter (P0-7).

| Capture | Frames | Output px per source px at 2.5× | Result |
|---|---|---|---|
| Headless (DPR 2 asked) | 1440×900 (F1) | 2.64 | Readable but visibly soft, JPEG artefacts on icons and small text: [crop](phase0/f2-zoom-2.5x-headless.png) |
| **Headed, DPR 2, Retina Mac** | **2880×1800, ~59 fps** | **1.32** | **Sharp**: [crop](phase0/f2-zoom-2.5x-headed-retina.png) |

The headed probe used `page.screencast.start({ size: viewport × DPR })`: the recorder now asks for
device pixels (it asked for CSS pixels before, which scaled headed frames back down).

**Decision for now:** takes meant for export are recorded **headed at DPR 2** on a high-DPI screen
(`scripts/record.ts --headed`). Headless stays for tests and CI (CSS resolution, zoom soft above
~1.5×). The compositor reports `softness` (output pixels per source pixel at the highest zoom):
above ~1.5 it's visibly soft, the editor should warn.

**Open (v0):** a headed window is visible to the user during recording (an app window behind the
editor, or off-screen, needs testing); Windows and Linux high-DPI behaviour is unmeasured; on a
non-Retina screen, headed frames are CSS resolution again (fall back to a larger viewport or a
lower zoom cap).

## F3. Compositor and export (2026-09-27)

- **Canvas 2D instead of PixiJS:** the scene is one video layer, a camera transform and a few
  overlays. Canvas 2D is GPU-accelerated in Chromium, has a native blur (`ctx.filter`), adds no
  dependency, and the same `drawScene` runs in the editor and in the export. PixiJS stays an
  option if the live preview needs it (effects, many layers).
- **WebCodecs needs a secure context:** `about:blank` and plain `http://` origins have no
  `VideoEncoder`. The exporter serves its page from a privileged `kiframe://` scheme; the browser
  tests use `http://localhost`.
- **Codecs:** Electron 44 on macOS encodes H.264 (OpenH264, software); Playwright's Chromium on
  macOS reports H.264, VP9, VP8 and AV1 encoders. MP4/H.264 export of 9 s at 1080p30 takes ~5 s.


## F4. Driving a packaged Electron app: CDP works where `_electron.launch` doesn't (2026-09-27)

**Test (P0-10):** smterm 0.1.37 as installed (`/Applications/smterm.app`, ad-hoc signed, default
fuses), a copy with only `EnableNodeCliInspectArguments` off, and a copy with four fuses hardened
(`RunAsNode`, `EnableNodeCliInspectArguments`, `EnableNodeOptionsEnvironmentVariable` off,
`OnlyLoadAppFromAsar` on), each re-signed ad hoc. Script: `scripts/p0-10/electron-check.ts`.
Each launch uses its own temporary `--user-data-dir`, so it never attaches to a running instance
(single-instance lock) or its sessions. The CDP path uses `--remote-debugging-port=0` and reads the
port Chromium picked from `DevToolsActivePort` in that profile (no attaching to another browser).
Frames are counted over 1 s on the visible main window, with a forced repaint every frame.

| App | `_electron.launch` | `--remote-debugging-port=0` + `connectOverCDP` |
|---|---|---|
| smterm, default fuses | ✅ 2.9 s to the window; ~100 fps screencast | ✅ 2.0 s; ~100 fps |
| smterm, **only** the Node inspect fuse off | ❌ times out | ✅ 2.0 s; ~90 fps |
| smterm, 4 fuses hardened | ❌ times out | ✅ 1.9 s; ~100 fps |

The inspect fuse alone is enough to break `_electron.launch` (it drives the app through Node's
`--inspect`). Screencast rates are the same on both paths (a first run without the forced repaint
counted 6 vs 35 frames: frames only come on repaint, and the terminal barely repainted).

**Decision for now:** the Electron target (v0.1) uses **`--remote-debugging-port=0` +
`connectOverCDP`** (APPROACHES §0, §6b): it doesn't depend on the Node fuses, which shipping apps
increasingly turn off. `_electron.launch` stays a convenience for dev builds.

**Open (v0.1):**
- An app can still refuse the switch: `app.commandLine.removeSwitch("remote-debugging-port")` in
  its main process, or a check that quits (the script reports "exited before opening a debugging
  port" for that case). Then the only way is a debug build: say so in onboarding.
- **Security of the port:** anything on the machine can connect to a remote-debugging port while
  it's open. Port `0` (random, read from `DevToolsActivePort`), 127.0.0.1 only, and open only for
  the recording.
- A separate `--user-data-dir` means a fresh profile: the app's own login state isn't there.
  Recording an app with its real data needs the user's profile, which conflicts with the running
  instance (the user must quit the app first, or the app supports a second profile).

## F5. State: 5/5 clean takes on app.dim0.net with ensure + teardown + session reuse (2026-09-27)

**Test (P0-9):** `examples/dim0/board-state.yaml` (create a board, name it "Q4 roadmap"; the
teardown deletes it: hover the card, Delete, confirm), replayed 5 times by
`scripts/p0-9/replay.ts` on one persistent profile (cookies, localStorage and IndexedDB carried
from run to run, like an account whose data persists). Runs 2 and 4 skip their final teardown on
purpose (an interrupted run). Report: [p0-9-dim0-report.json](phase0/p0-9-dim0-report.json).

| Run | Interrupted | Session preset | `ensure` found leftovers | Clean | On camera |
|---|---|---|---|---|---|
| 1 | | ran | no | ✅ | 10.8 s (cold, see catalogue #4) |
| 2 | yes | skipped | no | ✅ | 5.4 s |
| 3 | | skipped | **yes → teardown, setup again** | ✅ | 5.4 s |
| 4 | yes | skipped | no | ✅ | 5.3 s |
| 5 | | skipped | **yes → teardown, setup again** | ✅ | 5.4 s |

Clean = the take is complete, no warnings, no teardown error, every step ran. Re-run after the
review fixes (`ensure` waits for late lists, its cleanup runs inside the step): 5/5 again, and run 1
wasn't slow that time ([report 2](phase0/p0-9-dim0-report-2.json)): the cold start varies. Warm runs are
consistent: each step within ~100 ms from run to run.

**Limits:** dim0 has no accounts, so the session preset only opens the app; session reuse was
exercised through the carried profile. A login preset is checked on the P0-8 app. Failure classes
seen are in `docs/FAILURE-CATALOGUE.md`.
