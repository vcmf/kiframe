# Failure catalogue

> What went wrong (or nearly) when replaying scenes on real apps, and what handles it. Started in
> Phase 0 (IMPLEMENTATION-PLAN §2); feeds `PHASE0-REPORT.md`, the agent's grounding rules and the
> runtime backlog. One row per failure *class*, with the app where it was first seen.

| # | Class | Seen on | What happened | Handled by | Status |
|---|---|---|---|---|---|
| 1 | Duplicate name in a hidden container | app.dim0.net | "Untitled board" is both the header title and an item of the collapsed sidebar (translated off screen, still "visible" to Playwright) → `target-ambiguous` | `nth: 1` in the scenario; the error says to add `nth` | Grounding (P0-8) should prefer the on-screen match; backlog: count off-screen (transformed-away) matches as hidden |
| 2 | Control that only appears on hover | app.dim0.net | A board card's "Delete board" is `display: none` until the card is hovered | `hover` action (pulled forward from M1-2 for P0-9) | Done |
| 3 | Destructive confirm dialog | app.dim0.net | Deleting a board opens "Delete this board?" (Cancel / Delete) | `risky: true` on both clicks; pre-approved for the sandbox app by the harness | Done (approval per environment: v0) |
| 4 | Cold first run | app.dim0.net | First replay in a fresh profile: 4.1 s per click step vs ~1.3 s warm (lazy loading on first use); settle waits up to its 3 s cap | Settle (network + DOM quiet); the idle speed-up hides it on video | Watch: a warm-up run before recording, if it shows in videos |
| 5 | Leftovers from an interrupted run | app.dim0.net | A run whose teardown didn't happen leaves "Q4 roadmap"; the next run would film a duplicate | `ensure: { absent }` runs the scene's teardown first, then replays the setup | Done: 5/5 clean with two interrupted runs (PHASE0-FINDINGS F5) |
| 6 | "Absent" vs "not loaded yet" | app.dim0.net (risk) | Boards load from IndexedDB after the page: an `ensure: absent` checked too early passes while the board exists | `ensure` settles first (network + DOM quiet) | Risk: for lists loaded late, put a `waitFor` on the list before the `ensure` |
| 7 | App data in the browser profile | app.dim0.net | Local-first app: "the account" is the profile's IndexedDB, not a server | Session reuse carries `storageState({ indexedDB: true })` between runs | Done; a login-based session preset is still untested (needs an app with accounts) |
