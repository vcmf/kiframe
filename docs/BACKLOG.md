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
- **Double-click event timing:** when recording, a trial click checks actionability before the press is reported, but a double click's first press/release pair is still emitted before Playwright's clicks.
- **Round trips per click:** up to ~6–8 sequential page calls (probes, boxes, border read, viewport). `pointProbe` could return the box and borders in the same call.

## @kiframe/runtime recorder (P0-5)
- **Sensitive rects follow the element:** a vault-filled field's rect is logged once at `type_start` (full frame if it has no box). The schema allows re-logging when it moves (scroll, re-layout); the recorder should track it (and the DOM-text scan for secret text shown elsewhere, APPROACHES §7.4) before v0.
- **Frames through a pipe:** frames are written as JPEG files then encoded by ffmpeg after the run; piping them into ffmpeg (image2pipe) would avoid the temporary files. Needs ffmpeg on PATH (Phase 0).
- **Secrets encoded inside larger values:** the scrubber catches each secret and its common encodings, but not a secret embedded in a larger encoded value (e.g. `base64("user:hunter2")` in a URL). The vault's field binding (APPROACHES §7.4) and keeping URLs out of takes where possible are the real defences.
