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

## Loading frames (Phase 0 report)
- **White loading frames:** a navigation shows the blank page while the next one loads (Cal.com after "Continue"). Events can't tell loading from idle: detect near-blank or unchanged frames by frame difference, then cut or speed them (clips generator), and keep the camera wide over them.

## Phase 0 harnesses
- **Harness output:** Phase 0 scripts print errors to stdout/stderr; runs launched with output discarded lose them (one Cal.com replay failure went undiagnosed that way). Write each run's error into its report file too.

## @kiframe/schema model (M1-1)
- **Account types** (`User`, `Org`, `Membership`, `Invitation`, APPROACHES §10c) come with the server (M5-3); M1-1 has only what the desktop reads (org settings, user preferences).
- **Later kinds:** `still` / `media` scenes (v0.1), `gif-per-scene` / `html-presentation` outputs (later), `capture: dom`.
- **Two Style shapes:** the schema's nested `Style` (and overrides) vs the compositor's flat `Style` (with the output size); `styleFrom` maps one to the other. Unify when the compositor is completed (M3-2).
- **Export size from outputs:** the exporter CLI renders at 1920×1080 (a composition's style can no longer set the size, M1-1): take the size from a project output (preset / format) in M3-3.
- **Keep the `migrated` flag:** the parse functions drop it; the project store (M1-9) needs it to rewrite upgraded files.
- **Social-cut presets:** `vertical` / `square` should also tighten the camera and enlarge captions (OBJECT-MODEL §0.5); only the size follows the preset today.

## @kiframe/runtime actions (M1-2)
- **Popup windows of another size:** tabs share the context viewport, but a `window.open` with its own width/height films at that size: the take then has a frame-size change (only warned, see P0-5). Film popups at the take's size, or letterbox them.
- **Several pages opened in one step:** the last one opened is followed; the others stay open in the background, undriven.
- **`hover.hold`:** OBJECT-MODEL lists a hover `hold?`; the common `hold` (a freeze after the step) covers the presentation beat, a hover that keeps the pointer for a duration isn't implemented.
- **`select` on camera:** the native dropdown isn't in the screencast (the value just changes); a custom overlay could show the options.
- **Slow popups:** pages are followed at step boundaries. A popup whose first response comes after the opening step settled (a slow OAuth provider) is picked up at the next boundary: the step right after it still runs on the opener. Re-check pending popups while a target is being resolved, or wait briefly after actions that can open one (M1-2 review round 7).
- **Risky selects (auto-detection):** only `risky: true` gates a `select`: judging options by their words flagged ordinary choices ("Pay yearly", "Invite only"); the submit click is checked anyway.
- **Nested "continue in a new window":** a popup that opens a tab and closes itself returns to its opener (the tab stays undriven); a step failing mid-close before the teardown leaves no page to clean up on. Prefer the newest open page the closed one opened.
- **Drag framing after re-layout:** the press rect uses the drop point planned before the drag starts, not the re-measured one.
- **Uploads and drags without events:** a hidden-input upload and Playwright's fallback drag report no cursor, press or rect (no framing, the clips generator may call the step idle); an opener that opens a tab in the same step its popup closed loses that tab.
- **Per-page state:** page, tracker, cursor, listeners live in parallel maps saved/restored by `switchPage`: one `Map<Page, PageState>` would replace them. Secret fields are also measured twice on a step that switches pages.
- **Page-following cleanups:** `ctx.network` could be a getter of the page registry; `reportPress` / the click-event block in `clickAtCursor` share one shape; the teardown's "return to the start page" has no step of its own (events tagged teardown index 0).
- **Risky drags (auto-detection):** only `risky: true` gates a drag. Judging the drop target by its text flagged ordinary drops ("Drop files here", a column holding a "Remove" card, M1-2 review): it needs the drop target's own label (the control under the drop point), like the click check.
- **Late hidden file input:** an input that renders after the first check is found only after `find` waited its whole timeout for a visible match: wait for both at once.
- **Several hidden file inputs:** the hidden-input path needs exactly one match of the primary locator (no `nth`, no fallbacks): use the target resolution with a hidden-allowed mode.
- **Late file chooser in headed mode:** a chooser that opens after the step's timeout isn't intercepted any more, so the OS dialog shows: keep a listener that cancels it until the step ends.
- **Drag of long lists:** a drag doesn't auto-scroll the page while held; a drop target off screen fails with "the drop target isn't on screen".

## @kiframe/runtime interrupts and hide (M1-3)
- **`ensure` and interrupts:** an `ensure` check doesn't run the interrupt check first; a banner over the list can hide what `ensure: absent` looks for (it then passes). Run the check at the start of `ensure` too.
- **Stacked interrupts:** rules are tried in config order, not stacking order. A cookie banner (rule 1) under a "What's new" modal (rule 2) fails the step: rule 1's button is covered. Try the next matching rule when a `do` fails, then come back to the first.
- **Interrupt check cost:** one locator count per rule, before every step and on every covered click. For a long org rule bank, one combined `or()` count for the common no-match case, then find the rule.
- **Hide under a strict CSP:** a `style-src` without inline styles blocks the injected style (a take warning says so). Use a constructable stylesheet (`adoptedStyleSheets`) or the context's `bypassCSP` where Kiframe creates the context.
- **Interrupt actions' events:** the `do` action runs with an off-camera ref (phase `setup`): its cursor samples and click events land inside the cut span, tagged setup. Harmless for the video; a dedicated phase would be cleaner for the timeline editor.
- **Mid-step interrupts beyond clicks:** a covered target is handled inside a click (the probe sees it covered); a `type` into an input a modal covers isn't (no step retry: a retry could repeat an action that already happened).
- **Hide rules per page, not per run:** the init script stays on the page, so a harness running two projects on one page keeps the first one's hide rules.
- **Hide in iframes:** the CSS is injected in the top document only; widgets inside iframes (a chat iframe) stay visible unless the iframe element itself is hidden.
- **A rule that comes back on the same page:** rules run at most once per page (the simplest robust form after three review rounds: a banner faded out in place still matches). A survey that re-appears later on the same page isn't handled again; the step it covers fails. A real "is it still there" test (hit-testing, not visibility) would allow re-running.
- **Interrupts appearing during a step:** checked at step boundaries and in covered clicks only; a banner appearing during a `pause` or a long `type` is filmed until the next boundary, then cut away abruptly. A watcher during filmed steps (or a crossfade at the cut) would hide it.
- **Caption freeze and mid-step cuts:** a click that handles an interrupt has a cut inside its span; the clips generator's reading-time freeze counts the full span, so its caption can be shown shorter than its reading time.
- **Interrupt ref phase:** the `do` action's ref is phase `setup` with the scene step's index; approvals and events name it `interrupt <rule>`, but a host keying on phase + index would point at a setup step. A dedicated phase (see above).
- **CSP warning coverage:** the hide warning tests the document loaded when hide is applied; a later document with a strict CSP blocks the init-script style silently.

## @kiframe/runtime state (M1-4)
- **Session across batches:** the saved session lives in memory for one batch; every batch logs in again. Keeping it (encrypted, keychain) between batches would cut logins further (M1-7/M1-8 decide where secrets at rest live).
- **Session validation:** a stale saved session is noticed only when a scene fails (the next one logs in again, the failed one isn't retried). A scene that signs out on camera revokes the server session behind the saved state, so the next scene fails too. A cheap check after the context is created (the preset's last `waitFor`, say) would catch it before filming.
- **Several session presets:** a scene reuses the saved state only if it holds every session preset it uses; a scene logging in from scratch replaces it (the others log in again later). Two accounts of one app in one batch aren't supported.
- **Scoped sandbox pre-approvals:** a sandbox pre-approves teardowns and `ensure` cleanups only. Pre-approving named destructive actions in the scene itself ("may delete projects named *Q4 Launch*", APPROACHES §7.2) needs the approval UI (M2-4).
- **Session landing URL:** a skipped login goes back to the path and query it ended on; a query carrying a one-time token would be replayed (and appear in navigate events until M1-6 scrubs navigate URLs).
- **Which failures drop the session:** any step failure on a reused session (but a setup error) drops it, a stale selector included: a batch of scenes with broken selectors logs in again after each. Telling a signed-out page apart (the login page's URL) would keep it.
- **Refresh-token rotation:** every scene restores the snapshot taken after the login; an app rotating refresh tokens (Supabase, Auth0) rejects it once a scene refreshed. Saving the state again at the end of a successful scene would follow the rotation (at the cost of carrying what the scene did).
- **Setup indexes of skipped presets:** a skipped session preset becomes one `goto`, so later setup indexes differ between a fresh-login take and a reused one. Keep the preset's indexes reserved.
- **Session preset lookup:** `sessionPresetsOf` (batch) and `expandSetup` (runner) both decide what a session preset is; export one helper.
- **Sessions in sessionStorage:** Playwright's storage state carries cookies, localStorage and IndexedDB, not sessionStorage. An app keeping its token there arrives signed out on every reused scene (and the batch logs in again after each failure). Carry sessionStorage with an init script, or detect it and turn reuse off for the project.
- **`ensure` replay after a fresh login:** it replays the login preset's `goto`s (the login page, signed in), not the page the login ended on; after a reused login it goes to that page. Replay the landing in both cases.
- **One snapshot per scene:** each session preset that finishes saves the full state (IndexedDB included); with two in one scene the first is thrown away. Save once, after the scene's last session preset.
