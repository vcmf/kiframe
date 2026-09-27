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

"keep" modules graduate to v0. "throwaway" modules (Phase 0 experiments in `scripts/`) are removed one by one when their v0 replacement ships, not all at once: `scripts/record.ts` (headed DPR 2 recording) until M6-1/M4, `scripts/p0-8/` and `scripts/lib/` (the grounding reference) until M2-5/M2-7.
