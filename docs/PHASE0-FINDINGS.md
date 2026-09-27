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

