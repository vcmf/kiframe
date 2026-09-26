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
