# Phase 0 report

> Phase 0 (IMPLEMENTATION-PLAN §2) tested the three big unknowns on real apps: **quality** (would we
> publish the video?), **grounding** (can an agent write and ground a scene, at what cost?) and
> **state** (do replays stay clean?). Details of each result are in `PHASE0-FINDINGS.md` (F1–F6);
> every failure seen is in `FAILURE-CATALOGUE.md`. Written 2026-09-27.

## Verdict: go, with four things to close before v0 relies on them

The pipeline works end to end on two real web apps: **an agent writes a scene from a one-line
goal, grounds it on the live app, and the take is recorded and exported to a 1080p MP4 with no
manual edit**, for about **$0.02 and 3–4 minutes** per scene with DeepSeek V4.1 Flash ($0.17–0.22
and 6–12 minutes with GLM 5.3). Replays stay clean with `ensure` + `teardown`. Still open (below):
**camera timing** and **loading frames** keep the videos just short of "publish as is" (code we
own: generators, clips, loading detection); **reusing one login across a batch** is still to prove
on an app with accounts; and **smterm has no video** (only its driveability was checked, F4;
Electron recording is v0.1). And v0 is bigger than planned: ~54k LOC, not ~29k.

## Exit criteria

| Criterion | Result | Status |
|---|---|---|
| 1 exported MP4 per test app we would publish as is, 2.5× zoom acceptably sharp, captions readable (never sped up) | app.dim0.net (hand-written 2.5× scene, and an agent-written one) and Cal.com (agent-written), 1080p H.264 through Electron. 2.5× is **sharp when recorded headed at DPR 2** on a Retina Mac (1.32 output px per source px), soft headless (2.64): F1, F2. Captions are never sped up and get reading freezes | ⚠️ **Almost, for the two web apps.** Rough edges: the camera sometimes lags the caption (lead-in timing, BACKLOG P0-6/P0-7 camera items), and a page load shows as a white frame (Cal.com: needs loading detection from frame differences, BACKLOG "Loading frames"). **smterm has no MP4**: P0-10 only checked that a packaged Electron app can be driven (F4); recording Electron targets is v0.1 |
| Grounding: ≥ 2 of 3 apps grounded with ≤ 5 questions; tokens, cost and time measured | **2 / 2 web apps grounded, 0 questions**, with two models each. $0.013–0.019 per scene (DeepSeek V4.1 Flash), $0.17–0.22 (GLM 5.3); 2.7–12 min; prompt caching 94–97% (F6). The third app (smterm, Electron) was checked for driveability, not grounded (F4) | ✅ |
| State: 5/5 clean takes on at least one app with `ensure` + `teardown` + session reuse | **5/5 on app.dim0.net, twice**, with two deliberately interrupted runs cleaned up by `ensure` (F5). Session reuse via the carried profile (dim0 has no accounts). The Cal.com login preset ran in P0-8, but reusing a login session across runs is still untested | ⚠️ **Met on app.dim0.net**; the login-session part of "session reuse" (one login per batch) is still to prove on an app with accounts. **Proven in M1-4 (2026-09-28):** `recordBatch` on Cal.com, 3/3 scenes with one login (`scripts/m1-4/batch-check.ts`) |
| This report, the failure catalogue, v0 re-estimates | This file, `FAILURE-CATALOGUE.md` (12 classes), below | ✅ |

## What we learned (and what changed in the plan)

1. **Capture resolution (F1, F2).** Headless Chromium screencasts at CSS resolution whatever you ask.
   Sharp zooms need a **headed window on a high-DPI screen** (2880×1800 at ~59 fps for a 1440×900
   viewport). APPROACHES §0 (Capture) and §6 are updated: v0 records in a headed window on a
   high-DPI screen; where that window lives is open (it's visible today).
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
   vs the $0.5–3 guessed in APPROACHES §4. Wall time is (one tool call per turn). Most failed runs
   were caused by our tools (a step runner that couldn't run the login preset, steps sent as YAML
   strings rejected, a silent timeout on an off-screen button, a step timeout too short for
   Cal.com). The model made two kinds of mistakes: it re-grounded everything by hand instead of
   calling `finish`, and it relied on a panel it had opened while exploring (FAILURE-CATALOGUE #9).
   **Replaying the scene from scratch before accepting it** caught the second; a prompt rule
   fixed the first. Agent stack changed to
   cooldown's OpenAI-compatible client via OpenRouter (user preference, APPROACHES §0).
6. **Process.** Review rounds dropped from 8–13 per PR (P0-2: 13, P0-3: 8, P0-4: 10, P0-5: 10)
   to 1–3 (P0-6, P0-7, P0-9, P0-10) once "severe" was defined strictly (blocks the exit criteria, or a regression) and
   everything else went to `BACKLOG.md`. **P0-8 took 6**, all driven by one change: to give the
   agent a clear reason for clicks on off-screen buttons, I changed how targets are *resolved*
   (skipping off-screen matches, grace periods, fallbacks), and each fix caused the next
   regression. It ended as a diagnosis on the failure path only (the error says "off screen"),
   which was all grounding needed. Lesson: when the need is a better message, change the failure
   path, not the success path.

## Failure catalogue (summary)

12 classes so far (`FAILURE-CATALOGUE.md`), including one unexplained Cal.com replay failure (it passed right after): duplicate names in hidden containers, hover-only
controls, destructive confirm dialogs, cold first runs, leftovers from interrupted runs,
"absent" vs "not loaded yet", app data in the browser profile, slow hydration (Cal.com login > 6 s),
UI state leaking from exploration into the scene, targets off screen in collapsed panels, and tool
arguments sent as strings. Each has its handling and status; they seed the M2-8 healing eval.

## Re-estimates for v0

Phase 0 measured **~11.2k LOC** (6.7k source + 4.5k tests; IMPLEMENTATION-PLAN counts LOC as
production code + tests) against a **~6k** plan: **~1.85× over**, in 11 PRs (P0-1 to P0-10, plus a separate P0-4 fixes PR). Most of the excess is
hardening that the review rounds asked for (secrets scrubbing, fail-closed checks, timing edge
cases) and tests for it. The same factor is applied to v0, minus what Phase 0 already built. Code
marked *keep* (schema, runtime, recorder, generators, compositor, `apps/exporter`) graduates. The
throwaway `scripts/` stay until their v0 replacements ship (README has the schedule): the
recording and replay scripts until M6-1/M4, the grounding scripts until M2-5/M2-7 (for which
`p0-8/ground.ts` is the reference), the Electron check until V1-3, and `scripts/lib/` with the
last of them.

| Milestone | Plan | ×1.85 | Built in Phase 0 (keep code, −) | New work found (+) | Re-estimate |
|---|---|---|---|---|---|
| M1 Core engine | 7.4k | 13.7k | M1-4 state (`ensure`, session presets, `hover`): −0.4k; part of M1-6 (secret scrubbing, blur following fields, from P0-5): −0.5k | per-environment step timeouts, off-screen duplicates as hidden: +0.2k | **~13k** |
| M2 Agent | 6.2k | 11.5k | none (`scripts/p0-8/ground.ts` is a throwaway reference, rewritten in M2-5/M2-7) | — | **~11.5k** |
| M3 Rendering | 4.3k | 8k | — | camera timing in output time, loading-frame detection, cursor shapes: +0.5k | **~8.5k** |
| M4 Desktop app | 6.1k | 11.3k | — | headed recording window (placement, high-DPI detection, fallback): +0.2k | **~11.5k** |
| M5 Server | 3.8k | 7k | — | — | **~7k** |
| M6 CLI | 1.5k | 2.8k | Electron exporter CLI (`apps/exporter`): −0.3k | — | **~2.5k** |
| **Total** | **~29k** | **~54k** | −1.2k | +0.9k | **~54k** |

So v0 is **~54k LOC**, not ~29k: plan for it (IMPLEMENTATION-PLAN §3 now points here). Phase 0
landed **outside** the plan's ±50% band (+85%): the band itself is too narrow for this kind of work,
so treat ~54k as the middle of a range, not a ceiling.

## Open questions for v0

- **The recording window:** headed capture is visible on screen. Can it live behind the editor, on
  a virtual display, or off screen, and still give device-pixel frames? (macOS first; Windows and
  Linux high-DPI are unmeasured.)
- **Loading and idle detection:** events alone call a page that loads content "idle"; frame
  differences would tell real idleness from loading (and cut white loading frames).
- **Human in the loop:** 0 questions were needed on these goals. Missing secrets, ambiguous goals
  and risky actions on real (non-sandbox) data need their own tests and the per-environment
  pre-approval list before v0.
- **Model choice:** DeepSeek V4.1 Flash is the default for now (F6: fewest failures, cheapest,
  fastest on both apps), GLM 5.3 the alternative. Keep measuring on more apps and on heal runs;
  in the scripts the default is a CLI default (`--model`), in v0 it becomes a setting.
