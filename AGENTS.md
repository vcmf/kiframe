# Kiframe

A desktop app where a chat agent records product demo videos: it grounds each scene on the live
app (real browser), saves it as a YAML scenario, replays it from scratch and films it at human pace.

## Repo map

- `packages/schema`: Zod schemas and types (project, scenario, take, composition), the step reference.
- `packages/runtime`: Playwright runner and recorder: targets, actions, approvals, secrets in the page.
- `packages/vault`: secret store (keychain) and grants. `packages/project`: project folder, take store.
- `packages/agent`: the model loop (openai SDK via OpenRouter). `packages/studio`: the agent's tools
  and prompt (snapshot, run_step(s), save_scene, record_scene).
- `packages/generators`, `packages/compositor`, `apps/exporter`: take → composition → video.
- `apps/desktop`: Electron app (main, sandboxed preload, React renderer).
- `scripts/real-apps/drive.ts`: drives the built app on minmux.dev, Cal.com, Excalidraw with the real model.

## Commands

`pnpm check` (lint + format + typecheck + tests, the CI gate) · `pnpm test` · `pnpm format` ·
`pnpm --filter @kiframe/desktop dev | build | e2e` · `node scripts/real-apps/drive.ts --app calcom`.

## Docs (read on demand)

`docs/APPROACHES.md` (decisions) · `docs/OBJECT-MODEL.md` (formats) · `docs/SECRETS-DESIGN.md` ·
`docs/IMPLEMENTATION-PLAN.md` (phases) · `docs/FAILURE-CATALOGUE.md` (what real apps broke, and the
fix) · `docs/BACKLOG.md` (known gaps and follow-ups).

## Commits and PRs

- Conventional Commits / Commitizen: `type(scope): subject`. Scope mandatory and specific
  (`studio`, `runtime`, `schema`, `desktop`, …); subject imperative, lowercase, no trailing period;
  breaking → `!` or a `BREAKING CHANGE:` footer. One logical change per commit. No emoji.
- PR titles in the same format: PRs are squash-merged, so the title becomes the commit.
- No AI attribution lines (`Co-Authored-By`, "Generated with …") in commits or PRs.
- The repo is public: check the diff for secrets before every push.

## Conventions

- TypeScript strict (`exactOptionalPropertyTypes`), no semicolons, kebab-case files.
- One short doc comment on non-obvious functions and types: the why, not the how.
- Tests come with the change. A failing test is evidence: never weaken it; a fix's test must fail
  with the bug put back.
- Try features on the real apps (minmux.dev, Cal.com, Excalidraw), not only on fixtures.

## Invariants

- **Secrets never reach the model.** The agent sees secret names, never values; every tool result
  and error is scrubbed (`studio/tools.ts`); a secret is typed only into the approved field.
- **Black box.** Kiframe works on apps it doesn't control: no test ids, no seed hooks; locators are
  role, label, text, placeholder (css last).
- **Risky actions are approved** by the user (sandbox environments may pre-approve teardowns).
- **A step result is data** (`StepResult`): read structurally, never parsed from its words; tools
  return a failure as `{ error }`.
- **A ref is never in a scene's YAML**: it becomes a locator that finds that element alone (never a
  place among look-alikes).
