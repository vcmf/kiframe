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
- **Camera tuning:** padding (element ≤ ~60% of the frame), lead-in (400–1000 ms by distance), cluster gap (2.5 s), bridge (800 ms) and the 1.2× minimum are first guesses, to tune on the test apps in P0-7.
