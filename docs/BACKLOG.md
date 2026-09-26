# Kiframe backlog

Non-severe review findings deferred on purpose (see the review-round rule: only severe findings trigger a new round).

## @kiframe/schema (P0-2)
- **JSON Schema export:** exported schemas are `guarded()` transforms, so `z.toJSONSchema(Scenario)` throws. When the agent/tool layer needs a JSON Schema of the formats, expose the base schemas for introspection (or move the guard into a `.check()` on the base).
- **Action / Step duplication:** both unions list the 8 action variants (guarded by a drift test). Revisit when M1-1 adds the full action set.
- **Parse options:** `guarded()` re-runs the inner schema with default options (custom error maps, `reportInput`, async refinements aren't forwarded). Not needed today.

## @kiframe/runtime (P0-3)
- **Network idle vs long-polling:** requests are treated as long-lived only after 15 s (so slow API calls still count). Apps that re-issue a long-poll more often than that can't use `waitFor: { networkIdle: true }`, and each step's settle waits its full 3 s cap. Options: per-project `network.ignore` URL patterns, or detecting repeated same-URL requests.
