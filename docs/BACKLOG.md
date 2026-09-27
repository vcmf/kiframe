# Kiframe backlog

Non-severe review findings deferred on purpose (see the review-round rule: only severe findings trigger a new round).

## @kiframe/schema (P0-2)
- **JSON Schema export:** exported schemas are `guarded()` transforms, so `z.toJSONSchema(Scenario)` throws. When the agent/tool layer needs a JSON Schema of the formats, expose the base schemas for introspection (or move the guard into a `.check()` on the base).
- **Action / Step duplication:** both unions list the 8 action variants (guarded by a drift test). Revisit when M1-1 adds the full action set.
- **Parse options:** `guarded()` re-runs the inner schema with default options (custom error maps, `reportInput`, async refinements aren't forwarded). Not needed today.

## @kiframe/runtime (P0-3)
- **Network idle vs long-polling:** requests are treated as long-lived only after 15 s (so slow API calls still count). Apps that re-issue a long-poll more often than that can't use `waitFor: { networkIdle: true }`, and each step's settle waits its full 3 s cap. Options: per-project `network.ignore` URL patterns, or detecting repeated same-URL requests.
- **Risky detection via the keyboard:** `type … submit: true` and `press: Enter / Mod+Enter` can submit a form whose button is "Send"/"Invite" without label-based approval (only `click` is checked). Check the form's default submit button label.
- **Shadow roots attached during settle:** `domQuiet` observes open shadow roots that exist when settle starts; a component that calls `attachShadow` later isn't observed.
- **Leaving the app without secrets:** a redirect or link to another origin (SSO does this on purpose) lets non-secret actions continue there. Decide per environment (allowed origins) with the vault's origin binding.
- **Base path in the target URL:** `goto: /projects` on `https://host/tenant-a/` goes to `/projects` (WHATWG root-relative). Decide whether "relative to the environment" should keep the base path.
- **Fallback winning too early:** on the first polling round a fallback can win before a late-rendering primary appears (wrong element + false `target_fallback`). Add a short grace period before accepting a fallback.
- **Caret with delegated focus:** when focus lands on a descendant (shadow host with `delegatesFocus`), the caret is moved on the target, not on the focused element.
- **Main scroller inside shadow DOM:** `findMainScroller` doesn't search shadow roots (web-component app shells).
- **Text conditions are substring and case-insensitive:** `expect text: Saved` passes on "Unsaved changes". Consider an `exact` option or word boundaries.
- **Settle / scroll cost on large DOMs:** a full TreeWalker per settle to find shadow roots, and an `isConnected` round trip before each scroll.
- **Cursor when the target is off screen before a click:** `find()` scrolls the target into view first, but if it moves off screen after the cursor travel, no cursor event is emitted and `ctx.cursor` keeps the old position while Playwright moves the real mouse.
- **No cursor events without a box:** when the target has no visible box, Playwright's regular click is used (approval required unless `risky` is set): no cursor movement is shown and `ctx.cursor` goes stale.
- **Listener errors across step boundaries:** a late navigation from a step that already finished/failed can be attributed to the next step (or teardown) and fail it.
- **Box lost after the cursor travel:** if the target re-renders or slides off screen during the travel, the click runs at the element's center without press/release events, and `ctx.cursor` is wrong.
- **Instant pacing doesn't re-measure after the hover:** a control that changes size on hover can be clicked at a stale offset (off camera only).
- **Clip the aim point to clipping ancestors / fixed headers:** `visiblePart` clips to the viewport only. A covered point gets one re-aim, then Playwright picks the point (the cursor visual may jump); aiming directly at the uncovered part would avoid that.
- **Risky label vs Playwright's hit check:** the risky label is read by our probe just before `locator.click`; Playwright then re-checks the hit target at dispatch. A re-render in between can only make Playwright's click fail or retry (it won't click a different element), but the label that was approved could differ from the final one in rare timing.
- **Double-click event timing:** a double click's first press/release pair is emitted before Playwright's clicks.
- **Round trips per click:** up to ~6–8 sequential page calls (probes, boxes, border read, viewport). `pointProbe` could return the box and borders in the same call.

## @kiframe/runtime recorder (P0-5)
- **Sensitive rects follow the element within a step:** a vault-filled field is re-measured at each step end (a new `sensitive` rect when it moved, an empty rect when it's gone). During a step that moves it (smooth scroll, re-layout) the blur lags; sampling per frame would fix it. Also the DOM-text scan for secret text shown elsewhere (APPROACHES §7.4), before v0.
- **Stale recording folders after a crash:** `.<name>.recording-*` and `<name>.old-*` are removed in-process only; after a kill they stay (unblurred frames). Sweep folders whose pid is dead at the next recording / app start.
- **Frame size change mid-take:** only warned; `meta.frameSize` is the first frame's, and ffmpeg gets mixed sizes. Split the take or scale frames when a real app resizes during a take.
- **Frames through a pipe:** frames are written as JPEG files then encoded by ffmpeg after the run; piping them into ffmpeg (image2pipe) would avoid the temporary files. Needs ffmpeg on PATH (Phase 0).
- **Secrets encoded inside larger values:** the scrubber catches each secret and its common encodings, but not a secret embedded in a larger encoded value (e.g. `base64("user:hunter2")` in a URL). The vault's field binding (APPROACHES §7.4) and keeping URLs out of takes where possible are the real defences.
- **Click event before dispatch:** the click event is logged just before `locator.click` (no trial click: Playwright's trial really presses the mouse). If the click then fails, the step and the take fail, so the logged click is never in a usable take.
- **Follow the typed element, not the locator:** a secret field is re-found through its locator (`visible`, `nth`), so a new matching field above it can take the blur; a field hidden (tab switch) ends its blur and is unblurred when shown again until the step ends. Keep the element handle (and handle navigation as "gone"), sample per frame.
- **Gone fields keep being measured:** each secret field costs a round trip or two after every later step, even once gone; stop after a navigation, or shorter timeout.
- **One scrub point for take writers:** scrubbing happens at the runner's exits (navigate, errors, teardown_failed); the recorder's writers (events, warnings) don't scrub. Expose a scrub function to the recorder and apply it to every record.
- **scrubError loses the error class:** a non-StepError is rebuilt as a plain Error (name kept) when a secret was resolved; `instanceof TimeoutError` differs with/without the vault.
- **Scrubber regex per call:** `scrubSecrets` rebuilds the variants and the alternation on every navigation / error; cache it on the context when a secret is resolved.

## @kiframe/generators (P0-6)
- **`camera: { frame: <locator> }` and `emphasis`:** the runner doesn't log `frame_target` rects yet, so framing another element falls back to wide (with a warning), and no highlight/spotlight masks are generated.
- **Keystroke overlay:** `keystrokes: show` produces no `KeystrokeSegment` yet.
- **Regenerate with manual segments:** `generate` returns auto segments only; merging with manual ones and flagging orphaned anchors (OBJECT-MODEL §4.1) comes with the editor.
- **Idle detection is event-based:** a page that animates or loads content without cursor/keyboard activity is seen as idle and sped up (reason `network` only when a navigation is inside the gap). Frame-difference detection would tell real idleness apart.
- **Events grouped by step once:** camera and cursor generators scan all events per step (O(steps × events)); a `Map<stepId, events>` on the timeline would do it once.
- **Camera hold and lead-in in output time:** cluster gaps and the bridge are judged in output time, but the minimum hold (1.3 s), the lead-in and the cap on a wait's extension (`start + gap`) are still source time: inside a sped-up stretch a hold is shorter on screen, and a framing can end partway through a sped-up wait.
- **Camera tuning:** padding (element ≤ ~60% of the frame), lead-in (400–1000 ms by distance), cluster gap (2.5 s), bridge (800 ms) and the 1.2× minimum are first guesses, to tune on the test apps in P0-7.

## @kiframe/compositor + exporter (P0-7)
- **Cursor shape:** always an arrow; the samples' CSS `cursor` (pointer, text) isn't used yet.
- **Desktop window style:** no fake title bar for Electron targets; one style (padding, radius, shadow, gradient) for all.
- **Masks:** `pixelate` draws like `blur`; `highlight` / `spotlight` aren't drawn (none generated yet); `near-target` captions fall back to the bottom.
- **Follow-cursor spring:** the camera blends toward the moving cursor without its entry velocity (a small velocity kink when a follow segment starts).
- **Lead-in during a reading freeze:** the next framing's lead-in can start inside the previous step's reading freeze, so its caption is read while the view already moved on. Start lead-ins after the freeze (output time).
- **Precompute per-frame lookups:** `sceneAt` resolves every segment's anchors and scans events per frame (O(frames × segments × events)); resolve spans, ripple starts and sensitive rects once in `prepare` for long takes.
- **Opening zoom:** when the first framing's lead-in falls in the setup cut, the video starts already zoomed (no zoom-in from wide).
- **Softness warning in the editor:** `prepare().softness` is computed but only reported by the exporter's summary.
- **Big exports through base64:** the exporter returns the file from the page as base64 through `executeJavaScript`; long 4K exports should stream to disk (IPC chunks or a `StreamTarget`).
- **Electron export in CI:** only the browser export (WebM/VP9) is tested; the Electron MP4 path is run by hand (`apps/exporter/src/cli.ts`). Linux CI needs a display (xvfb) for Electron.
- **Headed recording window:** takes for export need a headed high-DPI window (PHASE0-FINDINGS F2); where it lives on screen during recording is open.

## @kiframe/runtime state (P0-9)
- **Off-screen matches count as visible:** an item of a collapsed sidebar (translated off screen) is "visible" to Playwright, so it makes a locator ambiguous (FAILURE-CATALOGUE #1). Treat elements entirely outside the viewport and not scrollable into it as hidden in `visibleOnly`.
- **`ensure` re-check replays the whole setup before it:** fine for `goto`-style setups; a setup with side effects (creating data) before an `ensure` would run them twice. Validate that only navigation/waits precede an `ensure`, or re-run a declared "context" part only.
- **Session presets saved at the end of a run:** the harness carries the whole profile after each run (app data included). For login presets, v0's batch runner should save right after `preset_done` and create every scene's context from that.
- **`ensure` settles on its own:** it settles (up to 3 s of network/DOM activity) even right after a step that just settled; on busy pages that's dead time off camera. Skip the settle when the previous entry settled.
- **`ensure: absent` always waits its 1 s grace:** the clean case pays the full grace (the wait only ends early when something appears). Use `count()` after settle, and the grace only after a declared late list (`waitFor` on it, FAILURE-CATALOGUE #6).
- **Harness dirty runs have no teardown at all:** their `ensure` can't clean an unexpected leftover. Skip only the final teardown (a runner option) or create the leftover with a separate scene.
- **Pre-approval per environment:** the harness approves every risky step (sandbox). v0 needs the per-environment pre-approval list (APPROACHES §7.2).

## Grounding (P0-8)
- **Clipped or covered collapsed panels:** "off screen" means the element's box is still outside the viewport after Playwright scrolls it into view. A sidebar collapsed to `width: 0; overflow: hidden`, or behind an overlay, still has a box on screen and times out without a reason; and scrolling into view can pull an off-canvas drawer in on pages with `overflow-x: hidden`. Use the centre-point probe (`isOnScreen`) when a pointer action's target can't be hit.
- **Off-screen targets in resolution:** the runner only *explains* a failed click/hover on an off-screen target (after the normal timeout). Skipping such targets (fallbacks, `nth`) or failing faster needs a rule that follows late mounts and slide-ins without regressions: four P0-8 review rounds went there, so it was cut back to the diagnosis.
- **Off-screen explanation behind the risky check:** a click with no on-screen point fails closed on the risky check first (`risky-not-approved`), so the off-screen reason only shows when the click is approved or `risky: false`. Checking off-screen before asking for approval changes behaviour: do it with the M1-2 action work, with tests.
- **Grounding replay pacing:** `finish` replays with instant cursor and typing; the recording uses the project's pacing. Every grounded scene also passed a paced recording, but the check should use real pacing (or at least real typing).
- **Grounding context growth:** every snapshot stays in the conversation and is resent each turn; elide old tool results (cooldown's `tool-result-view.ts`) in M2-5.
- **One overlap rule:** `canBeOnScreen` (targets.ts) and `visiblePart` (runner.ts) both test box vs viewport; share one.
- **Grounding harness lock:** the stale-lock takeover can race when two runs start on the same dead lock at the same moment (throwaway script; use a real lock library if it graduates).
- **Off-screen for conditions too:** `expect`/`waitFor` `visible` still count an element in a collapsed panel as visible (only click/hover check it can be brought on screen): a shared "reachable" filter next to `visibleOnly`.
- **Off-screen duplicates in `nth` / ambiguity:** they still count (existing scenes use `nth` to skip them). Counting only reachable matches is better, but needs a migration of `nth` in grounded scenes.
- **Risky approval in the grounding harness:** every step the model marks risky is approved (printed). The v0 agent needs per-environment pre-approval and a human check for anything not created by the scene (prompt injection from page text).

