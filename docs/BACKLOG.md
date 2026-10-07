# Kiframe backlog

## Must do before v0's release: secrets shown on the page (the scanner, V2–V4)

**Deferred 2026-10-04** (APPROACHES "Visual rebuild V2–V4"). Today a recording protects the field a secret is typed into (blurred from the write to the end of the scene) and never shows a value to the agent; **a secret the page itself displays elsewhere is not blurred in the video**: the demo account's email in an account menu or an owner column, an API key on a settings page, a token in a toast. So **v0 records on throwaway demo accounts only**, a rule the user is told, not one the code enforces. To close before release, one of:

- **The scanner, as designed** (SECRETS-DESIGN §5 R2–R10 and the §7 acceptance tests): complete scans at every step and every 300 ms, page changes streamed between them, spans that follow scrolls and recycled rows, blind stretches held or cut, model screenshots painted over, `••••` keystrokes. Live, costly while recording, and hard to get right in every frame.
- **A post-processing step** (the user's lean): after recording and before export, a pass over the take finds the known values (in the recorded page text, or in the frames: OCR) and adds blur regions; the export refuses a take that wasn't checked. Offline, simpler to verify; costs compute at export, and needs its own design review (what text the take keeps, OCR misses, values the page draws in images or canvas).
- **Meanwhile, in the app:** say it before the first recording of a project ("record with a demo account: a value the page shows, beyond the fields Kiframe types into, isn't blurred"), and in the export dialog.

## Must do: data persistence (rework, not a patch)

**Decided 2026-10-02, S3:** the app keeps a project's chat **in memory only**: it's gone when the app quits (the scenes, scenarios, compositions and takes it made are saved as before). This is a deliberate slice shortcut, and closing it is **a rework of the agent runtime and of storage**, not a file dump of the message list:

- **A proper store** (a database in app data, e.g. SQLite; not JSON files next to the project): chats and their messages, several chats per project, written as a turn goes (a crash keeps what was said), with versioning and migrations once it ships.
- **The agent runtime resumable from it:** a run's history (`AgentEvent.messages`, reasoning details, tool results and their elision state) stored as the loop produces it, and reloaded into `runAgent` exactly; an interrupted turn (a stop, a crash mid-tool) restored in a state the model can continue from.
- **Never a secret value in it:** tool results are scrubbed at the boundary today (S2b); the store must keep that guarantee (and its retention and encryption follow M1-8's take rules).
- **What links to what:** a chat's turns to the scenes and takes they made, so history survives a scene's rename or delete.


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
- **A named point and a box that only resized:** a click at `at` refuses when its point moved more than 2 px between the check and the click (after an approval too), even when the target only grew a little (a scrollbar appeared, a responsive canvas) and the fraction is still the spot approved. Interim: refused, the agent runs the step again (an approval asked again). Option: compare the point within the box (fractions), and refuse only a moved box whose element changed.
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
- **A first frame of another shape:** the take's frame size is the first frame's; on a slow machine (CI, 2026-09-30) that frame can have another aspect ratio than the viewport, and `TakeMeta.parse` throws a raw ZodError out of `recordScenario` (seen once in `recorder.test.ts` "keeps the good take…"). Take the size from frames matching the viewport's shape (or the most common one), and make a mismatch a failed take, not a thrown ZodError.
- **Frame size change mid-take:** only warned; `meta.frameSize` is the first frame's, and ffmpeg gets mixed sizes. Split the take or scale frames when a real app resizes during a take.
- **Frames through a pipe:** frames are written as JPEG files then encoded by ffmpeg after the run; piping them into ffmpeg (image2pipe) would avoid the temporary files. Needs ffmpeg on PATH (Phase 0).
- **Secrets encoded inside larger values:** the scrubber catches each secret and its common encodings, but not a secret embedded in a larger encoded value (e.g. `base64("user:hunter2")` in a URL). The vault's grants (SECRETS-DESIGN §3) and keeping URLs out of takes where possible are the real defences.
- **Click event before dispatch:** the click event is logged just before `locator.click` (no trial click: Playwright's trial really presses the mouse). If the click then fails, the step and the take fail, so the logged click is never in a usable take.
- **Follow the typed element, not the locator:** a secret field is re-found through its locator (`visible`, `nth`), so a new matching field above it can take the blur; a field hidden (tab switch) ends its blur and is unblurred when shown again until the step ends. Keep the element handle (and handle navigation as "gone"), sample per frame.
- **Gone fields keep being measured:** each secret field costs a round trip or two after every later step, even once gone; stop after a navigation, or shorter timeout.
- **One scrub point for take writers:** scrubbing happens at the runner's exits (navigate, errors); the recorder's writers (events, warnings) don't scrub. Expose a scrub function to the recorder and apply it to every record.
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
- **Session presets saved at the end of a run:** the harness carries the whole profile after each run (app data included). For login presets, v0's batch runner should save right after `preset_done` and create every scene's context from that.
- **Pre-approval per environment:** the harness approves every risky step (sandbox). v0 needs the per-environment pre-approval list (APPROACHES §7.2).

## Grounding (P0-8)
- **Clipped or covered collapsed panels:** "off screen" means the element's box is still outside the viewport after Playwright scrolls it into view. A sidebar collapsed to `width: 0; overflow: hidden`, or behind an overlay, still has a box on screen and times out without a reason; and scrolling into view can pull an off-canvas drawer in on pages with `overflow-x: hidden`. Use the centre-point probe (`isOnScreen`) when a pointer action's target can't be hit.
- **Off-screen targets in resolution:** the runner only *explains* a failed click/hover on an off-screen target (after the normal timeout). Skipping such targets (fallbacks, `nth`) or failing faster needs a rule that follows late mounts and slide-ins without regressions: four P0-8 review rounds went there, so it was cut back to the diagnosis.
- **Off-screen explanation behind the risky check:** a click with no on-screen point fails closed on the risky check first (`risky-not-approved`), so the off-screen reason only shows when the click is approved or `risky: false`. Checking off-screen before asking for approval changes behaviour: do it with the M1-2 action work, with tests.
- **Grounding replay pacing:** `finish` replays with instant cursor and typing; the recording uses the project's pacing. Every grounded scene also passed a paced recording, but the check should use real pacing (or at least real typing).
- **Grounding context growth:** every snapshot stays in the conversation and is resent each turn; elide old tool results (cooldown's `tool-result-view.ts`) in M2-5.
- **One overlap rule:** `canBeOnScreen` (targets.ts) and `visiblePart` (run/pointer.ts) both test box vs viewport; share one.
- **Grounding harness lock:** the stale-lock takeover can race when two runs start on the same dead lock at the same moment (throwaway script; use a real lock library if it graduates).
- **Off-screen for conditions too:** `expect`/`waitFor` `visible` still count an element in a collapsed panel as visible (only click/hover check it can be brought on screen): a shared "reachable" filter next to `visibleOnly`.
- **Off-screen duplicates in `nth` / ambiguity:** they still count (existing scenes use `nth` to skip them). Counting only reachable matches is better, but needs a migration of `nth` in grounded scenes.
- **Risky approval in the grounding harness:** every step the model marks risky is approved (printed). The v0 agent needs per-environment pre-approval and a human check for anything not created by the scene (prompt injection from page text).

## A project's apps (OBJECT-MODEL §0.9)
- **Environments (staging, prod) left out of v0:** each app has its own URL. When switching the same demo between copies of the app is wanted, an environment gives each app name its URL (an app it doesn't name keeps its own); the schema's `environment` field (org settings, from the server) is unused until then.

## Backgrounds (OBJECT-MODEL §0.14)
- **A frame's drawing cost under zoom:** the window's box is computed again for each frame (targetOf, the clamp, drawScene), and the window and each blur draw the whole frame magnified (clipped). Keep the box in Prepared, and draw only the source rect the output shows. The background image too: each frame resamples the whole 3840 px photo down to the output (high-quality smoothing); scale it once, at load, to the cover crop at the output's size × the zoom cap.
- **Shipped backgrounds** (`packages/compositor/backgrounds/`, chosen by the user 2026-10-05): three Unsplash photos (autumn road, forest lake, mountain lake), resized to 3840 px wide (sharp at a 2x zoom over a 1080p frame). The Unsplash License allows commercial use in a product without attribution; it forbids selling a photo unaltered and compiling photos into a competing service. Record each photo's Unsplash page in `backgrounds.json` (their sources weren't kept). More later: public-domain (CC0) images or ones we make; never macOS's own wallpapers (Apple's).

## Performance and resources (audit 2026-10-04, PERFORMANCE.md)
- **Playwright in the main process:** the agent's browser is driven from Electron's main process, so a recording's screencast (about 60 frames a second, JPEG decoded from base64) and the recorder's synchronous writes run on the main thread: 93% CPU at peak on minmux.dev. The window stayed responsive in the scripted measure (p95 2.9 ms), but a heavy page could stall the app's requests. Move the studio and runtime into a `utilityProcess`.
- **Live frames as binary:** frames go main → window as base64 strings (a third larger, a string per frame), up to 1600px at 8 a second; send the bytes (a Uint8Array over IPC) and size them to the stage's real pixels.
- **Live frames nobody sees:** the live view sends base64 JPEG frames (up to 8 a second) while the window shows the Preview tab or is closed (macOS); each becomes a new `data:` image. Pause them when the Live tab isn't shown, and send binary with blob URLs.
- **Opening a preview:** main reads the whole `frames.webm`, decrypts it synchronously and copies it to the window; a click through several scenes decrypts each (stale loads aren't cancelled). Measure on a long take (Cal.com's 72 s) and stream or cancel.
- **Tabs the app opens:** a popup the runner follows leaves its opener open, and a tab never followed stays, until the project closes (a headless renderer each). Close the live context's other pages after a step.
- **A failed take's records:** with `encodeFailed: false` the recorder still finishes its secret regions and writes events and cursor, which the store deletes as it settles: skip them too (only meta.json and warnings.json are kept).
- **The model's history:** every turn is resent each request (bulky tool results elided by recency): token cost grows over a long session. Compaction or a turn cap later.
- **Small:** `exportVideo` doesn't dispose its Mediabunny input or cancel its output on an error (fine in the exporter process; a leak if export moves into the app); a stop while the studio is still being set up builds one that's never used (harmless: lazy).

## Take store: eviction and vanished projects
- **Kept for good by design:** takes of a project only on a drive never plugged back, of a project never opened since the index existed (from before it, a CLI), whose meta doesn't read: listed in the storage view (M4-6) so the user can free them.
- **A take only another git branch names:** scratch (evicted past the grace and the budget): "its take is gone: record the scene again" when that branch is checked out (the honest contract).
- **The device rule (raised: a false gone now makes a project's takes scratch at once):** a removable or network volume's device number can be reused; another volume mounted at the same place with the same number would make a folder read as gone. Record the mount's own identity (its root's inode or birth time) too.
- **A vanished project found again:** a project moved and not opened since loses its takes when space runs short (the user's trade-off). Spotlight (`mdfind` on project.json's id) could find it moved and keep them.
- **Old paths kept forever:** the index never forgets a folder. One that later reads unknown (another project made there, a git tree) keeps its project's takes for good: a leak, never a loss (the storage view frees them).
- **A composition missing without an error** (mid-sync, `composition.json` absent): the scene reads as naming nothing, its named take scratch unless the newest. Treating a scene with a scenario but no composition as unread would close it.
- **Fewer passes:** once named takes alone pass the budget, every recording runs a pass that frees nothing (worker reads off the main thread). Remember the last pass's slack and skip while the store grew less; measure first.
- **A deleted scene's newest take** is kept (it may be named soon) and not counted: one take per deleted scene stays until the storage view frees it.
- **A failed recording that keeps its take** (the composition didn't save) doesn't run eviction: the next recording or start does.
- **A worker stuck on a dead network mount:** `terminate()` can't end a thread blocked in the kernel, and quitting may wait on it. Reading folders in a child process (Electron's `utilityProcess`, killed at quit) would close it; rare (a project on a share that stopped answering).
- **One realpath rule:** the index and the workspace each resolve a folder (realpath, else the path); share one helper.
- **Sizing on the main thread:** over the budget check, each take folder is measured once per launch (a recursive stat walk, kept in memory). Hundreds of takes with many shots can stall the window briefly at start; measure in the folder worker or keep sizes on disk.
- **A deleted project inside a git repo** is never gone (a branch may bring it back): its takes stay until the storage view (M4-6) frees them.
- **Named versions (M1-10):** their takes are named the same way only if a version's compositions are files in the project (or cached per commit); reading git refs at every eviction is too slow.
- **Not yet:** the storage view (sizes, "Free up space", deleting a pinned take with a warning: M4-6); export pins (M3-3: `exports/*.json` read the same way).

## Take store (M1-8): encryption at rest
- **Plaintext while recording:** the recorder writes frames, events and cursor plain into its staging folder (in the user-only store); the take is encrypted as it settles. A crash leaves them plain until the next start (its sweep deletes staging, its seal encrypts a placed take). Encrypting as the recorder writes would close it (the recorder taking a writer from the store).
- **Deleting isn't wiping:** a deleted take's bytes may stay on an SSD (encrypted, apart from the gap above). Forgetting the key forgets every take at once (a "delete all recordings" later).
- **Another machine:** takes don't move without their key (in this machine's keychain). An export of the key, or a store moved with it, later.
- **Sealing old takes at start:** a store from before M1-8 is encrypted at the first start (each file read whole, encrypted, written, one take at a time under the store's lock): seconds for gigabytes.
- **Exporter CLI:** reads plain takes only; an encrypted one is refused ("no take key here"). Exporting from the app (M3-3) decrypts in main.

## Preview (S4)
- **The take over IPC:** a preview reads frames.webm (async) and sends it to the window whole (tens of MB, cloned once). Stream it from the app's protocol instead (a range-capable URL for Mediabunny's `UrlSource`), with the project and take checked per request.
- **A slow machine:** Mediabunny asks for frame times ahead (up to the next keyframe) and inter-frame video decodes every frame between keyframes, so a machine that can't decode in real time skips late frames (one drawn at least every 100 ms: never frozen) and can fall behind the clock. A lower-resolution proxy of the take, or a decode in a worker, would fix it.
- **Not yet:** thumbnails in the scene strip, the whole video (every scene in sequence, transitions) in one player, export from the app.

## Acting by ref (PR #10)
- **Row-scoped targets (done):** a look-alike's target says its row (`in: { role, has }`), never a position. Gaps: a row whose distinguishing text sits in the row element itself (`<li>Acme <button>`; Playwright's `has` looks at descendants only) gets no row, so its ref is refused; rows are list items, table rows, articles, options and tree items (a card grid of `generic` divs has none). A row is named by a name-like text (`namesARow`), on the safe side: no time or date word, and no number without two words of its own ("Q4 Launch" is refused, so its row's look-alikes are written by hand). It stays a heuristic: a changing value said in words it doesn't know ("Sprint Alpha" renamed weekly) could still name a row; the replay checks the scene. A sturdier name would come from the app itself (the row's accessible name, a heading), when apps give one. Speed: a look-alike's row is found with sequential page round trips (decide each text's uniqueness in one page pass).
- **A unique element whose surroundings changed:** a ref's element is the same node, role and name (and, nameless, the same text) in the same document; the row it sits in isn't compared (a "row context" refused normal flows: a counter changing beside a button). The only checkbox of a list whose one row was renamed is still that checkbox.
- **A ref lost to a passing state:** a fresh snapshot taken while a button reads "Saving…" gives it a new ref (Playwright re-refs a node whose name changes), so the agent's ref for "Save" is refused later in the batch even once it reads "Save" again. Interim: refused, said why; a new snapshot gives it again.
- **Playwright's own generator:** `locator.normalize()` (what Playwright MCP reports) writes role/text/filter locators and checks uniqueness; map its output into the schema's locators (under the exact-names rule) instead of our own candidates, with the row-scoped targets above.
- **Cost:** each step with refs takes a fresh full-page snapshot (and up to 1.5 s of them when a ref is missing). Measure on large apps; check only after a step changed the page.

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

- **Selecting text in a clickable container:** `selectText` refuses where the release's click would land on something clickable: the passage's common ancestor (flat tree) is a link, a button, a label, a summary, an `[onclick]`, an ARIA control role, or has `cursor: pointer`; a start in a link or a draggable; an end in an option or a menu item. A plain element with a script click handler and no pointer cursor can't be seen: a selection there fires it, as a reader's would.
- **What `selectText` can't select (said when tried):** a passage across a component's edge (a range can't span shadow roots), in a closed shadow root or a child iframe (not walked: "not there"), text drawn on a canvas or by an app that draws its own selection (Google Docs, code views: "nothing got selected" / "draws its own selection"); CSS `::before` / `::after` text (in `find`, never selectable: the prompt says so). Text hidden from assistive tech (`aria-hidden`) is selectable but not in `find`.
- **The scroll to a passage isn't filmed smoothly:** it's instant, like every runtime scroll today (smooth scrolling is P0-4's).
- **Where a submit's Enter goes (as on main, but for one case):** Enter goes to the target (Playwright re-resolves and focuses it), except when the focused text field holds the typed text and the target is gone or doesn't hold it (a field the app swapped in mid-typing, a modal that took the keys): then Enter goes where the text is. Not handled, as on main: Enter on the next page or view after a search that runs as it's typed into (the target's locator finds the new box); a field disabled at submit while focus is elsewhere; focus moving between the read and the press (one round trip).
- **Typed keys follow focus:** `type` sends its keys through the keyboard, so if the app moves focus mid-typing they reach whatever has it (a space on a focused button presses it). Checking focus before every key would cost a page call per character.
- **The save replay doesn't move the pointer:** it types and settles at the recording's pace, but the pointer jumps (its travel is most of a recording's time): a hover effect the recording's cursor path triggers (a menu opening over the next target) fails only in the recording.
## @kiframe/runtime interrupts and hide (M1-3)
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
- **Session landing URL:** a skipped login goes back to the path and query it ended on; a query carrying a one-time token would be replayed (and appear in navigate events until M1-6 scrubs navigate URLs).
- **Which failures drop the session:** any step failure on a reused session (but a setup error) drops it, a stale selector included: a batch of scenes with broken selectors logs in again after each. Telling a signed-out page apart (the login page's URL) would keep it.
- **Refresh-token rotation:** every scene restores the snapshot taken after the login; an app rotating refresh tokens (Supabase, Auth0) rejects it once a scene refreshed. Saving the state again at the end of a successful scene would follow the rotation (at the cost of carrying what the scene did).
- **Setup indexes of skipped presets:** a skipped session preset becomes one `goto`, so later setup indexes differ between a fresh-login take and a reused one. Keep the preset's indexes reserved.
- **Session preset lookup:** `sessionPresetsOf` (batch) and `expandSetup` (run/setup.ts) both decide what a session preset is; export one helper.
- **Sessions in sessionStorage:** Playwright's storage state carries cookies, localStorage and IndexedDB, not sessionStorage. An app keeping its token there arrives signed out on every reused scene (and the batch logs in again after each failure). Carry sessionStorage with an init script, or detect it and turn reuse off for the project.
- **One snapshot per scene:** each session preset that finishes saves the full state (IndexedDB included); with two in one scene the first is thrown away. Save once, after the scene's last session preset.

## @kiframe/vault storage and resolver (M1-5)
- **Windows and Linux keychains:** keyring-rs covers Credential Manager and libsecret, but only macOS was exercised (the opt-in `keychain.test.ts`). Run it on both before the desktop app ships there; headless Linux without a Secret Service needs a fallback or a clear error.
- **Metadata integrity:** `vault.json` is a plain local file: anything running as the user can add an origin or a grant. Same trust level as the keychain itself on most systems; signing it (a MAC keyed from the keychain) would detect tampering.
- **`session` secrets:** saved sessions stay in memory for one batch (M1-4); storing them in the keychain (encrypted `storageState`) comes with keeping sessions across batches.
- **Keychain naming across orgs:** one keychain entry per secret name; two orgs using the same name on one machine share a value. Prefix entries with the org id once there are orgs (M5).
- **Secrets on other origins (SSO):** the runtime still requires the project's origin before the vault checks the secret's own origins, so a secret requested for an SSO page (auth.acme.com) is refused. One policy: let the vault's origins decide for vault-resolved secrets.
- **Refusal after the field was touched:** a secret is resolved once its field is focused (the grant check needs the element), so a refused or missing secret fails after `clear` emptied the field and the cursor moved. A pre-check of name, origin and grant before the step touches anything would fail earlier.
- **Refusals over IPC:** Electron drops custom error properties: the host must rethrow a refusal with `code: "secret-refused"` on the runtime's side, or the reason is lost (reported as unavailable).
- **One vault owner:** a `Vault` keeps its metadata in memory from `open`; two instances (or processes) on one `vault.json` overwrite each other. The desktop app must own it in one process (main) and serve the runtime through `resolver()`; re-reading the file in every update would allow more.
- **Keychain and metadata out of step:** a value is written to the keychain before its metadata; a disk error on the metadata leaves the new value without its new origin (the old value is gone). Write the metadata first and roll back on failure.

## @kiframe/runtime scrubber and scanner (M1-6)
- **Iframes and closed shadow roots:** the scan reads the top document and open shadow roots only; a secret shown in an iframe (an embedded account widget) or a closed shadow root isn't blurred.
- **Scan cost:** every 300 ms while recording, one walk over the visible text (a computed style per text node's parent). Fine for ordinary pages; a huge DOM (a long table) needs a MutationObserver-driven scan (only when the page changed) or a viewport-limited walk.
- **Hostile pages:** a page can alter what the scan sees (patching `TreeWalker`, drawing text on a canvas). It only hides its own data from the blur, never learns a value; drawn text (canvas, images) needs OCR.
- **Screenshot race:** a secret shown only between the two scans (appearing after the first and gone before the second) would be in the screenshot unpainted. Take the screenshot from a frozen page (CDP `Emulation.setScriptExecutionDisabled` around it) to close it.
- **Known values for skipped logins:** `knownSecretValues` has to be filled by the host (the vault's values for the project's secrets); the desktop app wires it (M4).
- **Lone surrogates:** the scrubber's patterns use the `u` flag; a secret value ending in half of a surrogate pair no longer matches inside a full pair. Values come from users' forms (well-formed text): drop the flag for such a value if it ever matters.
- **Scope after three review rounds (M1-6):** the scanner is kept to visible text nodes, open shadow roots and input/textarea values, with bounded 300 ms scans. Not covered: `<select>` options (a secret as the selected option), iframes, closed shadow roots, canvas/images.
- **Short values glued to other text:** a known value under 6 characters matches as a whole word only (scanner, A5, A8), so `x4821` holding the PIN `4821` isn't seen as a field holding a secret (the key allowlist and exact names don't apply to it). A substring match would treat every `administrators` as a secret; warn at `request` time for short values instead.
- **Region churn on movement:** a region is one exact box; a scrolling or animated secret ends and starts a region every scan (hundreds of mask segments on a long take). Carry an id across small moves, like secret fields.
- **Scan round trips:** four per scan (collect, parts, rects, viewport) and a style computed twice per text node's parent; return the viewport from `collect` and share the style.
- **Backdating to the run start:** when a new value becomes known, its first regions are blurred from the run's start (it may have been shown all along). A box that only held unrelated content earlier is blurred too.

## Vault hardening (M1-7)
- **Electron targets:** an app attached over CDP (F4) runs in its own persistent profile: no ephemeral context there. The app's own storage keeps whatever the scene typed; document it for Electron projects and prefer a throwaway app profile (`--user-data-dir` per run).
- **One launch helper:** browsers are launched by each entry point; nothing enforces an off-the-record context. A runtime-owned `launchBrowser()` / context factory would make it hard to bypass (the desktop app's main process).
- **Secrets into contenteditable:** v0 writes secrets to inputs and textareas only (the value set on the approved element); a rich-text field is refused.
- **Network exfiltration by the page itself:** a hostile page receives the typed password in its own field and can send it anywhere; that's the target app's own data. Out of scope for the vault (it only guarantees the value goes to the bound field on the allowed origins).
- **Suite growth:** add pages for a secret echoed in a `title`/`aria-label` (not text), in a `<select>`, in an iframe, and drawn on a canvas (the scanner's scope limits, M1-6), each asserting the documented behaviour.
- **A one-off Cal.com scene failure (2026-09-28):** one scene of one batch-check run failed right after the runner split (the next scene logged in again, as designed); 9/9 scenes passed in the three runs after it. The error wasn't captured (the output was cut): keep the full batch-check output when it next happens.

## Secrets authorization (SECRETS-DESIGN §3)
- **Exported grants for CI:** grants are per machine; a CI machine can't type a secret until the user exports named grants to it (§3 A4).
- **OS clipboard in headed runs:** the host clears it when a context ends (§3 A5, M4); the runtime never reads or writes it.
- **Phase 0 scripts bypass grants:** `scripts/lib/secrets.ts` resolves from the user's own `.env`, ignoring the use: the scripts are throwaway harnesses (removed with M6-1/M4), never the product path.
- **Clipboard permissions on a caller's context:** `recordBatch` refuses contexts with clipboard permissions; `runScenario` on a page the host created can't check (Playwright can't list granted permissions). The desktop app creates every context itself (M4): make it the only path.
- **Scene ids from file paths collide:** `scripts/lib/scenes.ts` `sceneIdOf` maps `cal-com/login.yaml` and `cal/com-login.yaml` to one id (shared approval keys). Harmless while scripts use the env resolver (no grants); the app's own scene ids are unique. Add a path hash if a script ever uses the vault.
- **Cost of the exact-names check:** while values are known, every poll of a locator query reads every text-like field's value, hidden or not, into Node (one round trip; skipped while a written field is attached, which already decides it). Fine for ordinary pages; a page with a huge textarea or thousands of inputs pays per poll. Cache per DOM mutation (a flag the page sets) if it shows up.
- **One in-page field walker:** the drag refusal, the focus check and the exact-names check each walk fields in the page (slightly differently). One shared helper would keep A5 and A8 consistent.
- **Playwright's own retries after a find:** a target found under one exact-names decision is then clicked, hovered or scrolled with that locator; Playwright's actionability retries re-query it with the same decision. A field holding a secret rendering into the target during that retry window could change the outcome (narrow). Re-resolving the target at each retry (our own actionability loop) would close it.
- **Pin every found target (A8 root cause):** `find` returns a lazy Playwright locator built with one exact-names decision; later uses (a scroll-until `within` container across rounds, click probes, the upload's hidden-input count) re-run its query with that decision. The secret write and its submit already go through the written element's handle; pinning every resolved target to an element handle (or rebuilding with `locatorFor` per use) would close the class. Narrow: a field holding a secret must render into the target's accessible name during the step.
- **Written-handle checks in one round trip:** `liveWritten` tests each handle's `isConnected` separately, then the field walk checks them again; one evaluate could do both and report which to prune.

## Secrets: displayed values and partial queries (planned, SECRETS-DESIGN §6)
- **Mask known values in partial queries (planned "A9", v0.1+):** after login a page shows the username (avatar alt, "Account bob@acme.com", owner columns, test ids); a hijacked agent can guess it one character at a time through partial role/label/text names (right guess found, wrong not). The design review (2026-09-29) of "ignore elements holding a value" found it leaky and breaking; the version that holds: for elements whose text (the whole accessible-name superset: subtree `textContent` with shadow roots, all subtree attribute values, field values, `labels`, `aria-labelledby`/`-describedby` texts, case- and whitespace-normalized, percent-decoded) holds a known value, match the query in Node against that text with every value (and its pieces across child nodes) replaced by a fixed token; pin the chosen element with a runtime marker (`data-kf-pick=<nonce>`, never in the A8 allowlist) so the action hits exactly it; any notice based on page state, never on the query; read once per poll across the page (with a cap). A sizeable subsystem (a partial re-implementation of Playwright's name matching); a temporary attribute written into the customer page.

## Secret regions: timing (SECRETS-DESIGN §5 T1–T8)

- **Stale frames after a read (stated gap, §6):** a frame drawn after `end + 50 ms` can still show content from before the read (slow raster, compositor-only frames). Options, decided later by the user: (1) a watermark strip, a counter the read bumps in a few pixel blocks along the bottom 8 px of the recorded page, cropped from every output: a box ends at the first frame whose counter is at or after the read's, exact; costs the page recorded 8 px taller and a bottom-fixed bar losing 8 px in outputs; (2) timing only (today's double-rAF + margin); (3) (2) plus launching the browser with threaded scrolling and animation disabled (every host must set the flags; slightly less smooth scrolling).
- **Motion between reads beyond the padding** (shake animations, elastic overscroll): widen a box to its clipping container while the element or an ancestor has running animations (`getAnimations()`).
- **Blur held on a static page (over-blur, T4):** a box left at `end` lasts until the next frame, and the screencast only sends frames on repaint: after a login lands on a static page, the old field's blur can stay for seconds (to the end of the scene if nothing repaints). Fix: when a box is left and no frame follows within ~100 ms, the recorder takes one screenshot (fresh by construction) and adds it as a frame at its capture time.
- **A gone field back while every read stays unsure (fails open, rare):** a field reported gone that re-mounts while its reads keep failing (a stuck page, timeouts) isn't reopened until a sure read finds it; reopening on "unknown" would blur whole pages after every flaky read. (A target matching several elements counts as present, the union of its rendered matches: never gone, never stuck.)

## @kiframe/project (S1)

- **A crash between two files of one scene save:** `saveScene` writes scene.json, scenario.yaml and composition.json one after another (each atomic). A crash in between can pair a new scenario with the old composition, whose take key names a take of the old scenario: a caller showing a take checks its `meta.scenarioHash` against the scenario (S4's preview), until a scene-level journal or one file per scene.
- **A duplicated project folder shares its id:** two folders with the same `project.json` id share one take directory (each lists the other's takes as its own; takes are matched by key, so a composition still finds its own). Fix: the app's open flow keeps a registry of project folders and gives a copy a new id.
- **Sync I/O on the main process:** the store is synchronous (small files; `latest` reads every take's meta of the scene: bounded once retention lands). An async API if the main process shows stalls.
- **Take retention (with M1-8):** every re-record keeps its take (raw, unblurred, unencrypted until M1-8): keep the takes a composition or export names plus the last few, and evict the rest (the LRU of OBJECT-MODEL §0.7).
- **Take durability:** the recorder's files aren't fsynced (a power loss right after a recording can leave a take whose frames are truncated while its meta survived). fsync in the recorder's swap, or check frames.webm on read.
- **Staleness: which take is a scene's current one (M1-8, needs a design):** today `latest()` is the newest complete take. The rule needs the inputs that shape footage (the scenario's actions, not its captions; the presets it uses, pacing, interrupt/hide/redaction rules, the app and viewport), in a canonical, versioned form (record key order, defaults across Kiframe updates). A review of a first attempt (whole config hashed) found it both over-stale and non-deterministic.

## @kiframe/agent (S2a)

- **A provider repeating call ids across turns:** the loop keeps the provider's ids (a thought signature in `reasoning_details` is bound to its call's id) and renames only a missing one or one repeated within a turn. A provider numbering calls per turn (`call_0` every turn) would repeat ids in the history: rename both the call and its reasoning entry's id then, once such a provider is used.
- **History is the engine's own output:** a history from another client isn't normalized (duplicate ids, dangling calls). Validate it on import, once one exists.
- **Reasoning history size:** streamed `reasoning_details` fragments are kept as received (OpenRouter's rule), which makes stored chats larger with thinking models. Compaction of old turns if it matters.

## @kiframe/studio (S2b)

- **A snapshot scrubbed twice:** it's scrubbed whole before its cut (a split value), then again at the tools' boundary: one scrubber passed in would do both.
- **Two error scrubs:** the tools' boundary rebuilds a scrubbed error (name kept) beside the runtime's `scrubError`; a StepError through a tool loses its reason and step. One shared helper when a tool needs them.

## @kiframe/desktop (S3a)

- **Main bundles the whole runtime:** `@kiframe/project`'s take store imports `isRecorderLeftover` from the `@kiframe/runtime` barrel, so main's bundle (≈390 KB) carries the runner and pngjs it doesn't use in S3a (S3b loads the runtime anyway). A leaf module for the leftover check, or a subpath export, if cold start matters.
- **The JS bundle is ≈700 KB** (React and the app; icons are tree-shaken): fine from disk, measure before splitting.
- **The sweep is synchronous:** after a crash with many leftover frames, `TakeStore.sweep()` (sync `rmSync`) blocks main for a while just after the window shows. An async sweep (fs/promises) when takes get large.

## @kiframe/desktop (S3b)

- **A removed scene's key:** `Registry.forgetScene` gives a reused scene id a new key (no inherited approvals), but nothing removes scenes in the app yet: wire it to the remove path when one exists (and to a scene folder deleted outside the app, noticed at open).
- **Markdown in the agent's answers:** shown as plain text (`pre-wrap`); cooldown's Streamdown renderer when answers carry lists and code.
- **A model picker:** the model is `deepseek/deepseek-v4.1-flash` for now (the composer shows it).
- **Thinking that streams no words:** the chat's "Thinking" row comes with the model's thinking text (never shown, only timed), from its first piece. A model whose thinking is opaque (OpenRouter's encrypted `reasoning_details` only) shows no row however long it thinks, and a model's wait before its first piece isn't counted. Base the row on the model's reply being under way, shown after a second or so (a row before every quick reply would be noise).
- **The fastest provider costs more:** the agent asks OpenRouter for its fastest provider (`provider.sort: throughput`, what `:nitro` does): Together on 2026-10-05, at $0.30 / $1.20 per M tokens in / out against CoreWeave's $0.20 / $0.65 on the default route. A traced Wikipedia run cost $0.19 (45 calls, 7.4 min, recorded) where slower runs cost $0.02–0.11 and never finished. Watch the cost per scene (and cache hits, if the fastest provider changes mid-run); the Phase 0 figures (APPROACHES, PHASE0) were measured on the default route. A gateway in front of OpenRouter (another `baseURL`) gets no `fastestProvider` (only openrouter.ai's endpoint does): give it an override like `sendReasoning`'s when one is used.
- **The live view polls for a page switch** (every 400 ms): a popup's first frames can be missed. A page-changed callback from the studio (where it follows the runner's switch) would replace the poll.
- **Long chats repaint whole:** each streamed update re-renders the column and scans the item list (main and window). Derived selectors and an id index when chats get long.
- **A tool's failure read from its words:** the chat tells a failed step by the studio's wording ("failed (…)", "replay failed: …"). The studio returning failures as soft errors (`{ error }`) would make it structural.
- **The project refreshed after a list of tools:** the host refreshes the scene strip after `save_scene` / `record_scene` by name. A project-changed callback from the studio (or `saveScene`) would cover any tool that writes the project.

## @kiframe/desktop (S3c)

- **Approve for a wider path** (§3 A3's third choice): the dialog has Allow and Decline; a grant covers the page's path pattern (ids as `*`). Add the wider choice when a real app needs it.
- **The approvals, listed:** the panel lists secrets, not their grants; removing a secret (or taking it off an app) drops its approvals. A per-step list with revoke (the vault has `grants` / `revoke`) when users ask what they approved.
- **The approval's screenshot is the page as it is** (APPROACHES §0, 2026-10-02): the user's own values typed earlier show in it (their own screen, to them only, never the agent or a take). Masking them proved fragile; revisit if screen sharing during approvals becomes a real case.
- **One secret for several apps:** the panel refuses a name another app already uses (its value there would be replaced unseen). Sharing one secret across apps (staging and prod logins alike) needs its own choice in the panel.
- **A secret on the app's other origins:** a secret is added for the project URL's origin, and typed there only (exact: its approval names that host). A login on the app's `www.` address (minmux.dev → www.minmux.dev) or an SSO host is refused ("off-origin", not an approval). Fixed for new projects (B1, 2026-10-06): the address is resolved when the project is created (the landed `www.`/https origin stored), so the secret is added for the origin the login is really on. A project created before keeps its address: its `apps.app.url` edited by hand, or re-resolved when apps can be edited (B4).
- **add_app's card and the panel:** bold the registrable domain of the host on the card (`docs.minmux.dev.evil.example`: `evil.example`; needs the public suffix list), and mark in the Secrets panel the apps the agent added (a phishing chain: an injected agent adds `login`, then asks the user to add a password for it).
- **The live page's size per app:** the agent grounds every scene at the first app's viewport (B3); a scene starting in an app with another size is grounded at the wrong size (the replay, at the filmed size, catches a layout difference). Doing it: a live context per start app (each logged in on its own), its live view following the new size, refs taken again after a switch.
- **Changing the first app** (where scenes without `app:` start): not offered (B5: it can't be removed); doing it means writing `app:` into every scene that relied on it, or warning they all move.
- **Secrets of a removed app's site:** they stay in the vault (other projects may use them) but no panel lists them while no app is on that site, and their names stay taken (adding `docs.token` for another app is refused); a "secrets of sites no app uses" section would let the user delete them.
- **Removing an app, what isn't counted or marked:** a scene whose scenario.yaml didn't read isn't counted in the confirmation; a preset naming the removed app is named in the confirmation but not marked afterwards (a scene using it is).
- **Org environments and projects:** since project v2 a project has no environment (each app has its own URL, never a sandbox); the org schema still declares environments (URL, sandbox, pre-approved teardowns, required secrets), used by nothing. Staging/prod switching, if it comes, maps an environment to each app's URL (OBJECT-MODEL §0.9).
- **The approval's step from its key:** the dialog's "Step" line is parsed from the runtime's step key; an `ApprovalRequest` carrying the step's parts (phase, id, preset, rule, scene key) would make it structural.
- **A grant stored before the chat says "Allowed":** the request is settled when the user answers, then the grant is stored; if storing fails (the secret removed meanwhile) the chat is revised to declined and the step fails as "unavailable". Storing first, then settling, would say it right the first time.
- **A studio made again once the vault reads:** it closes the live page (the agent's next step starts on a fresh one though its history says where it was). Rare (the vault unreadable at a project's first run); keep the live context when only the secrets change.
- **Why a secret step has no resolver:** with the vault unreadable, a secret step fails "no secret resolver given"; the Secrets panel says why, the run doesn't.
- **Stop during the approval's screenshot:** the screenshot (up to 3 s) isn't stopped by the run's signal.

## Real-app fixes (PR #9)

- **A point below the fold:** a step with `at` whose point is off screen is refused ("scroll it into view first"); scrolling the point itself into view (a tall canvas) when a real app needs it.
- **A project's address that redirects** (2026-10-05): the app's address redirected to `www.` or https is the app for its steps and URL checks (`sameApp`): scenes save and record there. Not for secrets (above).

## Project files (C1)

- **The cost of a write into pages/:** each write walks all of pages/ for its room check (up to 5,000 entries), lists each existing folder for its name check, and hashes the file it replaces. Fine at a page's size; keep running totals per `ProjectFiles` if a large pages/ makes the agent's edits slow.
- **Kept versions of the agent's file writes:** no restore yet (history, M1-10, undoes them); a "reveal" and a "forget kept versions" action; the 30-day and size sweep runs only over the open project's versions, when one is kept: a project moved (a new host scope), deleted or never written again keeps its versions (and emptied folders) until a sweep of every scope at startup.
- **Run notes (C3) on the main process:** story.md (up to 1 MB) and two listings are read synchronously at each run's start, and the scrubber is rebuilt every turn to scrub the notes again: read up to the cap only, and cache the scrubber by the set of known values. A passage copied from the notes where a tag spelling was neutralised (`<\project notes`) doesn't match the file in `edit_file`.
