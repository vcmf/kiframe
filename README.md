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

"keep" modules graduate to v0; "throwaway" modules (Phase 0 experiments) are deleted after the Phase 0 report.
