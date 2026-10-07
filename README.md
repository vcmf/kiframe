# Kiframe

AI agent that turns scenarios into product demo videos and guides. Design docs live in [`docs/`](./docs):
[approaches & decisions](./docs/APPROACHES.md) · [object model](./docs/OBJECT-MODEL.md) ·
[competitors](./docs/COMPETITORS.md) · [implementation plan](./docs/IMPLEMENTATION-PLAN.md).

## Development

Requires Node.js ≥ 22.18 and pnpm 10. Runtime tests drive a real Chromium: run `pnpm --filter @kiframe/runtime exec playwright install chromium` once.

```sh
pnpm install
pnpm check      # lint + format check + typecheck + tests (same gate as CI)
```

## Packages

| Package               | Role                                                       | Phase 0 status |
| --------------------- | ---------------------------------------------------------- | -------------- |
| `@kiframe/schema`     | Zod schemas + types (project, scenario, take, composition) | keep           |
| `@kiframe/runtime`    | Playwright automation, human motion, recorder              | keep           |
| `@kiframe/generators` | Take + scenario → auto composition segments                | keep           |
| `@kiframe/compositor` | Frame rendering + video export                             | keep           |

"keep" modules graduate to v0. "throwaway" modules (Phase 0 experiments in `scripts/`) are removed one by one when their v0 replacement ships: `record.ts` (headed recording) with M6-1/M4 (`p0-9/`, the replay harness for `ensure` and teardowns, went with them, 2026-10-07), `p0-8/` (the grounding reference) with M2-5/M2-7, `p0-10/` (Electron check) with V1-3, `m1-4/` (the batch login check on Cal.com) with M6-1, and `lib/` (shared by them) with the last one.
