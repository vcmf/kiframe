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
