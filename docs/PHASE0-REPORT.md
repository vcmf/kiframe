# Phase 0 report

> Phase 0 (IMPLEMENTATION-PLAN §2) tested the three big unknowns on real apps: **quality** (would we
> publish the video?), **grounding** (can an agent write and ground a scene, at what cost?) and
> **state** (do replays stay clean?). Details of each result are in `PHASE0-FINDINGS.md` (F1–F6);
> every failure seen is in `FAILURE-CATALOGUE.md`. Written 2026-09-27.

## Verdict: go, with two things to fix before v0 relies on them

The pipeline works end to end on two real web apps: **an agent writes a scene from a one-line
goal, grounds it on the live app, and the take is recorded and exported to a 1080p MP4 with no
manual edit**, for about **$0.02 and 3–4 minutes** per scene. Replays stay clean with `ensure` +
`teardown`. The two things that aren't "publish as is" yet are camera timing and loading frames
(below): both are in code we own (generators, clips), not in the approach.

## Exit criteria

| Criterion | Result | Status |
|---|---|---|
| 1 exported MP4 per test app we would publish as is, 2.5× zoom acceptably sharp, captions readable (never sped up) | app.dim0.net (hand-written 2.5× scene, and an agent-written one) and Cal.com (agent-written), 1080p H.264 through Electron. 2.5× is **sharp when recorded headed at DPR 2** on a Retina Mac (1.32 output px per source px), soft headless (2.64): F1, F2. Captions are never sped up and get reading freezes | ⚠️ **Almost.** Rough edges: the camera sometimes lags the caption (lead-in timing), and a page load shows as a white frame (Cal.com). Both are generator tuning (BACKLOG P0-6/P0-7) |
| Grounding: ≥ 2 of 3 apps grounded with ≤ 5 questions; tokens, cost and time measured | **2 / 2 web apps grounded, 0 questions**, with two models each. $0.013–0.019 per scene (DeepSeek V4.1 Flash), $0.17–0.22 (GLM 5.3); 2.7–12 min; prompt caching 94–97% (F6). The third app (smterm, Electron) was checked for driveability, not grounded (F4) | ✅ |
| State: 5/5 clean takes on at least one app with `ensure` + `teardown` + session reuse | **5/5 on app.dim0.net, twice**, with two deliberately interrupted runs cleaned up by `ensure` (F5). Session reuse via the carried profile (dim0 has no accounts). The Cal.com login preset ran in P0-8, but reusing a login session across runs is still untested | ✅ |
| This report, the failure catalogue, v0 re-estimates | This file, `FAILURE-CATALOGUE.md` (11 classes), below | ✅ |

## What we learned (and what changed in the plan)

1. **Capture resolution (F1, F2).** Headless Chromium screencasts at CSS resolution whatever you ask.
   Sharp zooms need a **headed window on a high-DPI screen** (2880×1800 at ~59 fps for a 1440×900
   viewport). Changes APPROACHES §6 "DPR 2 capture": v0 records in a (possibly hidden or
   background) headed window; where that window lives is open (it's visible today).
2. **Renderer (F3).** Canvas 2D instead of PixiJS: enough for one video layer, a spring camera and
   overlays; preview = export holds. Export: Mediabunny + WebCodecs in Electron (H.264), 9 s of
   1080p30 in ~5 s. WebCodecs needs a secure context (custom `kiframe://` scheme).
3. **Electron targets (F4).** `--remote-debugging-port=0` + `connectOverCDP` works on a hardened
   packaged app (smterm with its Node fuses off); `_electron.launch` doesn't. It is now the default
   for v0.1.
4. **State (F5).** `ensure: absent` (run the scene's own teardown on leftovers, then re-check) is
   enough for "data the scene creates". Failure modes found and fixed: an `ensure` cleanup failure
   must never pass as a harmless teardown failure; a failed `ensure` must not run the teardown
   (it would delete data the scene didn't create).
5. **Grounding (F6).** Cost is not the constraint: **$0.01–0.02 per scene** with a cheap model,
   vs the $0.5–3 guessed in APPROACHES §4. Wall time is (one tool call per turn). What made the
   difference was the harness, not the model: every failed run was caused by our tools (a step
   runner that couldn't run the login preset, a silent timeout on an off-screen button, a replay
   whose UI state differed from the live session). **Replaying the scene from scratch before
   accepting it** caught the one real grounding mistake the agent made. Agent stack changed to
   cooldown's OpenAI-compatible client via OpenRouter (user preference, APPROACHES §0).
6. **Process.** Review rounds dropped from 10–12 per PR (P0-2, P0-4, P0-5) to 1–3 (P0-6, P0-7,
   P0-9, P0-10) once "severe" was defined strictly (blocks the exit criteria, or a regression) and
   everything else went to `BACKLOG.md`. **P0-8 took 6**, all driven by one change: to give the
   agent a clear reason for clicks on off-screen buttons, I changed how targets are *resolved*
   (skipping off-screen matches, grace periods, fallbacks), and each fix caused the next
   regression. It ended as a diagnosis on the failure path only (the error says "off screen"),
   which was all grounding needed. Lesson: when the need is a better message, change the failure
   path, not the success path.

## Failure catalogue (summary)

11 classes so far (`FAILURE-CATALOGUE.md`), plus one unexplained Cal.com replay failure (it passed right after): duplicate names in hidden containers, hover-only
controls, destructive confirm dialogs, cold first runs, leftovers from interrupted runs,
"absent" vs "not loaded yet", app data in the browser profile, slow hydration (Cal.com login > 6 s),
UI state leaking from exploration into the scene, targets off screen in collapsed panels, and tool
arguments sent as strings. Each has its handling and status; they seed the M2-8 healing eval.

## Re-estimates for v0

Phase 0 came in close to plan: **~6.5k LOC of source** (plan ~6k) plus ~4.3k of tests, in 10 PRs.
The code is marked *keep* (schema, runtime, recorder, generators, compositor) or *throwaway*
(`scripts/`). Changes to the v0 plan (IMPLEMENTATION-PLAN §3):

| Milestone | Plan | Re-estimate | Why |
|---|---|---|---|
| M1 Core engine | ~7.4k | **~6.5k** | M1-4 (state: `ensure`, session presets, `hover`) is largely done in P0-9; M1-2 shrinks (hover done, `risky` detection done in P0-3/4). Add: per-environment step timeouts (FAILURE-CATALOGUE #8), off-screen duplicates as hidden (with `nth` migration) |
| M2 Agent | ~6.2k | **~5.5k** | M2-3 is a port of cooldown's client (no Anthropic-native client). M2-5/M2-7 start from `scripts/p0-8/ground.ts` (snapshot, run_step, replay-from-scratch). Add: an eval set from the failure catalogue, and tests for `ask_user` (missing secret, ambiguous goal), which Phase 0 never exercised |
| M3 Rendering | ~4.3k | **~4.8k** | Camera tuning in output time (hold, lead-in, lead-in after freezes), loading-frame detection (frame difference, not just events), cursor shapes from CSS. These are what stand between "almost" and "publish as is" |
| M4 Desktop app | ~6.1k | **~6.5k** | Headed recording window management (F2): hidden/background placement, high-DPI detection and fallback |
| M5 Server | ~3.8k | ~3.8k | Not touched by Phase 0 |
| M6 CLI | ~1.5k | ~1.3k | The Electron exporter CLI exists (`apps/exporter`) |
| **Total** | **~29k** | **~28k** | |

## Open questions for v0

- **The recording window:** headed capture is visible on screen. Can it live behind the editor, on
  a virtual display, or off screen, and still give device-pixel frames? (macOS first; Windows and
  Linux high-DPI are unmeasured.)
- **Loading and idle detection:** events alone call a page that loads content "idle"; frame
  differences would tell real idleness from loading (and cut white loading frames).
- **Human in the loop:** 0 questions were needed on these goals. Missing secrets, ambiguous goals
  and risky actions on real (non-sandbox) data need their own tests and the per-environment
  pre-approval list before v0.
- **Model choice:** DeepSeek V4.1 Flash was the best on both apps (fewest failures, cheapest,
  fastest); measure on more apps (and a heal run) before fixing a default.
