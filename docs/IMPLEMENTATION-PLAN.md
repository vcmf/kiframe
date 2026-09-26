# Kiframe: Implementation plan

> Status: draft, 2026-09-26. Derived from [APPROACHES.md](./APPROACHES.md) (§0 decisions, §11 roadmap) and [OBJECT-MODEL.md](./OBJECT-MODEL.md).
> Estimates are **rough** (±50%). LOC = production code + tests. They're meant for ordering and sizing, not for commitments. Re-estimate after Phase 0.

---

## 1. How we work

### Phases, milestones, PRs
- **A phase = a milestone** (a GitHub milestone) with **objectives** and **exit criteria**. A phase is done when its exit criteria pass, not when its PRs are merged.
- **A phase is split into PRs of ~200–800 LOC**, each **mergeable on its own**: CI green, no broken main, and unfinished features behind a flag. More than ~800 LOC means split it. A PR that changes a schema (`packages/schema`) comes **before** the PRs that use it.
- **Trunk-based:** short-lived branches off `main`, no long-lived phase branches.
- Every PR description states: objective, scope, what's out of scope, how it was tested, and the related doc section.

### Complexity scale
| | Meaning |
|---|---|
| **S** | Known pattern, little risk. ≤ 1–2 days |
| **M** | Some design decisions, moderate risk. ~3–5 days |
| **L** | Real unknowns or several subsystems. ~1–2 weeks |
| **XL** | Research or security-critical. Split it further if possible |

(The day counts assume one developer working with an AI coding assistant. Treat them as relative sizes.)

### Repository layout (monorepo, pnpm + TypeScript)
```
kiframe/
  packages/
    schema/        Zod schemas + types: project, scene, scenario, take events, composition, settings
    runtime/       Playwright automation: actions, targets, cursor planner, typing, interrupts, ensure/teardown, recorder
    vault/         keychain access, secret resolver (origin + field binding), output scrubber, DOM-text scanner
    generators/    pure functions: take + scenario → auto segments (camera, clips, captions, masks, cursor)
    compositor/    PixiJS renderFrame (analytic springs, cursor, masks, captions, cards) + WebCodecs/Mediabunny export
    guide/         guide output: Markdown / HTML / PDF
    store/         project folder IO, take store (pinned/scratch, encrypted), hidden git history, status computation
    agent/         agent loop (ported from cooldown), Anthropic LlmClient, tools, grounding and healing prompts
    cli/           headless `kiframe record | export | heal`
  apps/
    desktop/       Electron: main (agent, runtime, store) + renderer (React UI, compositor)
    server/        auth, users/orgs/memberships/invitations, settings (v0); LLM proxy + metering (v0.1)
```

**Node versions:** development and CI require Node ≥ 22.18 (native TypeScript type stripping); the server is deployed on Node 24 LTS, and Electron ships its own Node. CI should add a Node 24 job once the server package exists.

**Server stack decision:** **TypeScript on Node.js 24 LTS** (**Hono** + Postgres + Drizzle), not cooldown's FastAPI/Python, and not Bun. Node is required anyway for Electron's main process and is Playwright's officially supported runtime, so using it everywhere means one runtime, one test runner (Vitest) and one debugging setup. Hono runs on both Node and Bun, which keeps a later switch cheap. The reason is to share `packages/schema` (settings, orgs) between desktop and server, and to keep one language for a small team. We port the **design** of cooldown's metered proxy (`/ai/llm/stream`, `X-Run-Id` per run, ADR-AGENT-003), not its code.

---

## 2. Phase 0: Spike (pre-v0)

**Objective:** answer the three big unknowns before building the product (APPROACHES §11):
1. **Quality:** is an auto-generated scene, zoom and captions included, good enough to publish without manual edits?
2. **Grounding:** can the agent write and ground a 10–15 step scene on 3 web apps (one we don't control) with a handful of questions at most? **What does it cost per scene?**
3. **State:** do 5 consecutive replays on a resettable demo account give 5 clean takes?

**Exit criteria (go / no-go):**
- 1 exported MP4 per test app that **we would publish as is**, with a 2.5× zoom that stays acceptably sharp and captions that are readable (never sped up).
- Grounding: at least 2 of the 3 apps grounded with ≤ 5 questions each. **Measured** tokens, cost and time per scene written down.
- State: 5/5 clean takes on at least one app, using `ensure` + `teardown` + session reuse.
- A `PHASE0-REPORT.md` with results, the failure catalogue so far, and re-estimates for v0.

**Code policy:** spike code goes in the real monorepo, but each module is marked **keep** (graduates to v0) or **throwaway**. Schema, runtime, recorder, generators and compositor should be *keep*.

| PR | Objective | Scope | Cx | LOC |
|---|---|---|---|---|
| P0-1 | Monorepo scaffold | pnpm workspaces, TS strict, ESLint, Vitest, CI (lint + test), package skeletons | S | 300 |
| P0-2 | Schema v0 (minimal) | Zod: scenario (setup/steps/teardown, targets, v0 actions subset), take events, cursor samples, composition (clips/camera/captions/masks/cursor), `SegmentBase`/`Anchor` | M | 700 |
| P0-3 | Runtime: action runner | Resolve targets (role/label/text + fallbacks), actions `goto/click/type/press/scroll/waitFor/pause/expect`, settle, auto-scroll into view | M | 900 |
| P0-4 | Runtime: human motion | Cursor planner (Bézier + Fitts, ghost-cursor maths), real mouse moves, human typing, cursor samples with CSS `cursor` | M | 500 |
| P0-5 | Recorder | `page.screencast` at DPR 2, shared clock for events/cursor/frames, `step_start` shots, take writer (frames encoded to WebM: test WebCodecs vs ffmpeg and pick one) | L | 800 |
| P0-6 | Generators (minimal) | Camera (`target`, `auto` clusters), clips time-model rules (cut/speed/freeze, captions never sped up), captions, cursor ripples | M | 700 |
| P0-7 | Compositor + export (minimal) | PixiJS `renderFrame` (random-access, analytic spring), cursor drawing, captions, window style. WebCodecs + Mediabunny export in a minimal Electron window. Zoom cap vs source resolution | L | 1200 |
| P0-8 | Grounding experiment | A minimal agent script (Anthropic SDK directly, not the full loop yet): snapshot trimming, writes and grounds a scene YAML, logs tokens/cost/time | M | 600 |
| P0-9 | State experiment | `ensure` + `teardown` + session reuse (`storageState`), 5-replay harness, failure catalogue file | S | 400 |
| P0-10 | Electron target check | Script: `_electron.launch` vs `--remote-debugging-port` + `connectOverCDP` on one hardened packaged app. Report only | S | 150 |
| | **Total** | | | **~6k** |

Dependencies: P0-1 → P0-2 → (P0-3, P0-4) → P0-5 → P0-6 → P0-7. P0-8 needs P0-3. P0-9 needs P0-3. P0-10 is independent.

---

## 3. v0: First release

**Objective:** a usable desktop product for the v0 ICP: **B2B SaaS web apps with a resettable demo/staging account**. A user signs in, chats with the agent, gets scenes grounded and recorded, reorders them in the Sequence view, exports a **video** and a **guide**, and re-runs everything from the CLI when the UI changes.

**Exit criteria:**
- A new user goes from install → sign-in → first exported video + guide on their own app in **< 30 minutes**, with the agent asking only for real blockers.
- After a UI change on the test app, `kiframe heal` + re-record produces an up-to-date video and guide with no manual edit, for renamed or moved elements (flow changes may need the human).
- The vault passes a **security review** of the leak paths in APPROACHES §7.4 (a test suite with injected pages that try to exfiltrate).
- Signed and notarized builds for macOS and Windows, with auto-update working.
- Invite a teammate to an org, and they see the org's settings and the list of missing secrets.

The milestones below can partly run in parallel. Recommended order: **M1 → M2 → M3**, with **M4** starting after M1, and **M5 / M6** in parallel.

### M1: Core engine (spike → production)
| PR | Objective | Scope | Cx | LOC |
|---|---|---|---|---|
| M1-1 | Schema complete | All v0 types (project, scene kinds `recording`/`card`, outputs `video`/`guide`, settings layers, environments), schema versioning + migration hook | M | 900 |
| M1-2 | Runtime: full action set | `hover/select/drag/upload`, popups/new tabs, `risky` detection, `instant` typing | M | 800 |
| M1-3 | Runtime: interrupts & hide | Explicit interrupt check before cursor travel, re-plan the path, `interrupt` events → cut spans, CSS `hide` injection | M | 500 |
| M1-4 | Runtime: state | `ensure` (absent/present) with teardown, session presets (once per batch), sandbox pre-approvals | M | 600 |
| M1-5 | Vault: storage + resolver | Keychain (macOS/Windows/libsecret), `list/request`, resolution only in fill/type, origin + field binding | L | 900 |
| M1-6 | Vault: scrubber + scanner | Scrub exact + encoded variants (URL, JSON, HTML, base64, case), DOM-text scan → `sensitive` rects, blur for LLM screenshots, scrub navigate URLs | XL | 1000 |
| M1-7 | Vault: hardening | Ephemeral contexts, no password saving/autofill, tracing off, `evaluate` rules, exfiltration test suite (malicious pages) | L | 700 |
| M1-8 | Take store | Pinned/scratch, `pin.json`, LRU eviction, encryption at rest, take keys | M | 600 |
| M1-9 | Project store | Folder IO, stable serialization, computed status, exports/*.json | M | 700 |
| M1-10 | History | Hidden git (`GIT_DIR` in app data, isomorphic-git), checkpoints (agent turn, take, export, named version, idle), restore with warnings | M | 700 |
| | **Subtotal** | | | **~7.4k** |

### M2: Agent
| PR | Objective | Scope | Cx | LOC |
|---|---|---|---|---|
| M2-1 | Port the agent loop | Copy cooldown's `agent-loop`, `defineTool`, `tool-result`, `tool-result-view`, `stream-assemble` into `packages/agent` with their tests | S | 900 (mostly ported) |
| M2-2 | Loop fixes | AbortSignal, call ids on events, explicit max-turns event, keep assistant text, structured history replay, queued approvals, retry/backoff on 429/5xx | M | 800 |
| M2-3 | Anthropic LlmClient | Native messages API, tool_use blocks, prompt caching breakpoints, thinking, custom `baseURL` (for the proxy later) | M | 500 |
| M2-4 | HITL protocol | `requestUser({kind, schema})`: vault forms, risky confirmations, ambiguity questions (with screenshot), takeover. IPC contract | M | 500 |
| M2-5 | Browser tools | `browser.snapshot` (trimmed around the target), `browser.act`, `browser.screenshot` (blurred), all through the runtime + scrubber | L | 900 |
| M2-6 | Scene / composition / history tools | `scene.*`, `composition.setCamera/setSpeed/setCaption/describe`, `history.list/diff/restore` | M | 800 |
| M2-7 | Grounding | Intent → grounded target + fallbacks + fingerprint, verification with `expect`, storyboard, questions for blockers. Prompts + eval set | L | 1000 |
| M2-8 | Healing (basic) | On failure: try fallbacks → re-ground with the fingerprint → ask. Health check (`expect`) → `stale`. Eval on the Phase 0 failure catalogue | L | 800 |
| | **Subtotal** | | | **~6.2k** |

### M3: Rendering and outputs
| PR | Objective | Scope | Cx | LOC |
|---|---|---|---|---|
| M3-1 | Generators complete | All v0 rules (camera directives, emphasis, masks from sensitive events, keystrokes), rebase on re-record (auto replaced, manual kept, orphans flagged) | M | 900 |
| M3-2 | Compositor complete | Styles, fake window frame, masks (blur/highlight/spotlight), callouts, keystroke overlay, transitions, `card` scenes (templates) | L | 1800 |
| M3-3 | Export pipeline | Render queue, progress/cancel, codec detection + fallback (H.264 → VP9/AV1), presets landscape/vertical/square, `exports/*.json` + pinning | M | 800 |
| M3-4 | Guide output | Sections per scene, numbered instructions, shots + highlight boxes, Markdown / HTML / PDF | M | 800 |
| | **Subtotal** | | | **~4.3k** |

### M4: Desktop app
| PR | Objective | Scope | Cx | LOC |
|---|---|---|---|---|
| M4-1 | Electron shell | Main/renderer split, contextIsolation, typed IPC contracts (agent events, HITL, store, render), Playwright browser download on first run | M | 900 |
| M4-2 | Chat UI | Messages, streaming, tool steps, HITL dialogs. Adapted from cooldown's components (rewritten without the board/billing couplings) | L | 1500 |
| M4-3 | Sequence view | Scene cards (thumbnail, title, status), drag reorder, transitions, include/exclude per output | M | 1000 |
| M4-4 | Preview player | Scrubbing with the compositor, play scene / whole sequence, stale badges, storyboard fallback | M | 800 |
| M4-5 | Vault UI | Native secret forms, "secrets missing for this project", secret list per environment | S | 500 |
| M4-6 | Settings UI | User preferences, org settings (brand kit, environments, rule bank), project settings | M | 900 |
| M4-7 | Onboarding | Sign in, pick or create an environment (with the demo-account requirement explained), first scene guided by the agent | M | 500 |
| | **Subtotal** | | | **~6.1k** |

### M5: Server (accounts and orgs)
| PR | Objective | Scope | Cx | LOC |
|---|---|---|---|---|
| M5-1 | Server scaffold | Hono on Node 24, Postgres + Drizzle migrations, config, deploy pipeline | S | 500 |
| M5-2 | Auth | OAuth (Google, GitHub) + magic link, sessions/tokens for desktop, loopback flow endpoints | M | 800 |
| M5-3 | Orgs | Users (personal org at sign-up, `defaultOrgId`), orgs, memberships, roles, last-owner rule | M | 700 |
| M5-4 | Invitations | Email invitations, single-use hashed tokens, expiry, accept flow (existing and new users) | M | 600 |
| M5-5 | Settings API | Org and user settings, environments, rule bank, required secret names (names only). Versioned with optimistic concurrency | M | 600 |
| M5-6 | Desktop integration | Loopback sign-in in Electron, tokens in the keychain, org switcher, offline cache of settings | M | 600 |
| | **Subtotal** | | | **~3.8k** |

### M6: CLI and distribution
| PR | Objective | Scope | Cx | LOC |
|---|---|---|---|---|
| M6-1 | Headless CLI | `kiframe record/export/heal <project>`, uses the same packages. Compositor runs in Electron's Chromium (H.264), VP9 fallback | M | 700 |
| M6-2 | Signing & updates | macOS notarization, Windows code signing, auto-updater, release pipeline | M | 400 (mostly config) |
| M6-3 | Failure reports | Opt-in, scrubbed failure reports (scene, step, cause) feeding the failure catalogue | S | 400 |
| | **Subtotal** | | | **~1.5k** |

**v0 total: ~29k LOC**, in about 38 PRs.

---

## 4. v0.1

**Objective:** the Canvas view and desktop targets, plus the paid mode.

**Exit criteria:** Canvas and Sequence views stay in sync on the same project. An Electron app (dev build, and a hardened one through the CDP fallback) is recorded end to end. Paid users can work without a BYOK key, with per-org metering.

| PR | Objective | Scope | Cx | LOC |
|---|---|---|---|---|
| V1-1 | Canvas view | Port the `@canvas-harness` board, scene cards, notes, side panel reorder (from `slides-panel`), shared `sequence` | L | 2000 |
| V1-2 | Agent on canvas | Canvas tools (create/move scene cards, notes) | M | 500 |
| V1-3 | Electron targets | `_electron.launch` + `connectOverCDP` fallback, fake window frame | M | 800 |
| V1-4 | `still` + `media` scenes | Captured stills (self-updating), uploaded images, imported media with trim | M | 800 |
| V1-5 | Timeline editor | Tracks UI, drag/resize segments, manual vs auto, orphans | XL | 3000 |
| V1-6 | LLM proxy + metering | `/llm/stream` proxy, per-org metering, `X-Run-Id`, plan limits, retention policy applied | L | 1500 |
| V1-7 | Billing | Plans, checkout, plan enforcement in the desktop app | M | 800 |
| | **Total** | | | **~9.4k** |

---

## 5. Later (not planned in detail)
- HTML presentation and GIF outputs
- voiceover + languages
- Compare / variants in history
- TOTP in the vault
- Tauri targets
- team sync of projects
- CI integration (regenerate on every release)
- DOM-capture spike (OBJECT-MODEL §0.7, option C)

---

## 6. Biggest risks to the estimates
1. **Vault hardening (M1-6/M1-7)** is security work, and it's open-ended. Timebox it and get an external review before the paid proxy.
2. **Grounding and healing quality (M2-7/M2-8)** depends on prompts and evals more than code. The LOC count underestimates the iteration time.
3. **Compositor polish (M3-2)**: "nice to watch" takes many iterations of taste.
4. **Timeline editor (V1-5)** is the biggest single piece. Consider a reduced first version (camera + captions tracks only).
5. The Phase 0 results can change the plan: for example capture encoding, grounding cost, or the target ICP.
