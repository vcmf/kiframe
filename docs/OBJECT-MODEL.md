# Kiframe: Object model (what becomes a video)

> Status: draft. Created 2026-09-25, revised 2026-09-26 after an adversarial review. Companion to [APPROACHES.md](./APPROACHES.md).
> Question: *how do we represent the objects that become a video (or a guide…) at export?*
> Informed by prior art (APPROACHES §9): Cap (timeline tracks), OpenScreen (zoom regions, spring camera), demo-machine (scenario YAML), playwright-recast (trace as source of truth), programatic-demo and Screenize (events → camera), VHS (tape DSL), Maestro (YAML flows).

---

## 0. Project, scenes and views

### 0.1 Vocabulary
- **Project:** everything for one topic (for example "Q4 release"). Belongs to one **org** (APPROACHES §10c).
- **Scene:** one self-contained part of the story ("Create a project", "Invite a teammate"). Each scene has its own **three layers** (scenario → take → composition, §1–4).
- **Step:** one action inside a scene. *step* ⊂ *scene* ⊂ (later) *chapter*, an optional group of scenes (YouTube chapter markers, guide sections). Not in v0.
- **Sequence:** the **order** of the scenes, which is the story. **One sequence per project.**
- **Outputs:** what you export from the sequence (§0.5).

### 0.2 No edges: ordering is a list
There are **no edges** between scenes. The order lives in a list (`sequence`). This is the same pattern as cooldown's board, where `store.getFrames()` keeps a presentation order apart from positions (`chrome/slides-panel.tsx`, `views/linear-view.tsx`, `canvas/use-presentation-mode.ts`).

### 0.3 Views
| View | Version | What it's for | Reused from cooldown |
|---|---|---|---|
| **Sequence** (linear) | **v0** | A filmstrip/storyboard in story order. Drag to reorder, play one scene or the whole story, set transitions, see each scene's status | `views/linear-view.tsx` (sortable grid) |
| **Canvas** (spatial) | **v0.1** | Scene cards (thumbnail, title, status) plus notes, briefs and assets, in a free layout. The agent creates and edits scenes here. A **side panel** reorders the sequence without switching views | The `@canvas-harness` board, `chrome/slides-panel.tsx` |

**Presentation mode** (cooldown's `use-presentation-mode`) will be the preview of the HTML presentation output (later).

### 0.4 Scenes are self-contained
**No scene depends on the scene before it** for app state:
- Each scene has its own **off-camera `setup`**: navigate there, and create or check the data it needs with `ensure` (§2). Common setup is shared as **presets**.
- **Login is not repeated per scene.** A preset marked `session: true` (for example `login-as-manager`) runs **once per recording batch**. Its `storageState` is then reused for every scene of the batch (APPROACHES §7.2).
- Each scene can have an off-camera **`teardown`** that removes what it created. It's pre-approved on sandbox environments.
- Benefits: you can **reorder freely**, **re-record or heal one scene alone**, and reuse a scene in several outputs.
- Cost: recordings take longer because setup is repeated off-camera. That's acceptable, since it's invisible and needs no LLM.
- Joins between scenes are handled by **transitions** (cut, fade, slide), set in the Sequence view.

### 0.5 Sequence and outputs
- One sequence per project. Each output **includes or excludes** scenes (for example a 30s social cut with scenes 2 and 4) but **keeps the story order**.

```ts
type Project = {
  id: string;
  orgId: OrgId;                            // APPROACHES §10c
  scenes: Record<SceneId, Scene>;
  sequence: SceneId[];                     // the story order (the only ordering)
  canvas?: Record<SceneId | NoteId, { x: number; y: number; w: number; h: number }>;  // v0.1, layout only, no meaning
  presets: Record<string, Preset>;         // shared off-camera setups (§2)
  outputs: Output[];
};

type Output = {
  id: string;
  kind: "video" | "guide" | "gif-per-scene" | "html-presentation";
  preset?: "landscape" | "vertical" | "square";   // video only: 16:9 · 9:16 · 1:1. Sets format + camera + caption style
  include?: SceneId[];                     // default: every scene in `sequence`, in that order
  format?: { width: number; height: number; fps?: number };   // overrides the preset
  style?: Partial<Style>;                  // overrides the preset / project / org style
};
```

| Kind | Version | For | Content | Formats |
|---|---|---|---|---|
| `video` | **v0** | Watching (site, release notes, social) | The scenes one after another, with transitions. `vertical`/`square` presets = a **social cut**: tighter camera, larger captions burned into the image | MP4/WebM |
| `guide` | **v0** | **Reading and doing** (help center, docs, onboarding) | A Scribe/Tango-style tutorial. One section per scene (title + notes), then **one entry per step**: a numbered `instruction` + a **screenshot with the target highlighted** (box from the event rect) | Markdown, HTML, PDF. Later: publish to Notion, Confluence, Docusaurus/Mintlify |
| `gif-per-scene` | later | Docs, changelogs, READMEs, PRs | One looping GIF (or WebP/AVIF) per scene | GIF/WebP |
| `html-presentation` | later | **Presenting / clicking through** | One slide per scene, each with a short looping clip, the caption as **real text**, keyboard or click navigation. Self-contained | HTML (+ its media) |

**The guide comes almost free from the model:** steps (action + grounded target), events (the rect of each action) and the take's frames at each `step_start`. Two specific things:
- Each step has an **`instruction?`**, which is different from `caption`. A caption is short and marketing-toned ("Give it a name"). An instruction is precise and imperative ("Type your project's name in the **Project name** field"). The agent generates it and the user can edit it.
- Guide screenshots come from the take, so **the guide updates itself** with the scenes. Help-center screenshots are always out of date, which makes this a strong argument.

### 0.6 The Scene object

**Idea: a scene is "a base + overlays + a duration".** Only the base changes with the kind of scene. The overlays (captions, callouts, masks, camera, cursor) use the **same composition tracks** (§4) for every kind.

| Kind | Version | Base | Duration | Can go stale? | Examples |
|---|---|---|---|---|---|
| `recording` | **v0** | A take (frames + events) from a scenario | From the take (after speed-ups, cuts and freezes) | ✅ UI or scenario changed | "Create a project" |
| `card` | **v0** | A brand template (title, section, text, bullets, CTA, outro) | Fixed, or auto | ❌ | Intro, "Step 2: Invite", "Try it now" |
| `still` | v0.1 | An image: **captured from the app by the agent** (self-updating) or uploaded | Fixed, or auto | ✅ if captured | "Here's the dashboard", with a slow zoom + callouts |
| `media` | v0.1 | An imported file (video or animated GIF) | Media length, trimmed | ❌ | Founder clip, logo animation |
| *(later)* `terminal`, `html`, `avatar` | — | VHS-style terminal, a custom HTML slide, a talking head | — | — | — |

```ts
type Scene = {
  id: SceneId;
  title: string;                    // shown on the scene card, and as the slide/guide heading
  notes?: string;                   // the brief from the chat. Used by the guide and HTML outputs
  source: SceneSource;              // the base (varies by kind)
  composition: Composition;         // overlays, same tracks for every kind (§4)
  duration: { mode: "auto" } | { mode: "fixed"; ms: number };
  transitionIn?: { kind: "cut" | "fade" | "slide" | "zoom"; ms: number };  // join with the previous scene
};

type SceneSource =
  | { kind: "recording"; scenario: Scenario; capture?: { mode: "video" | "dom" } }  // default video. "dom" = later (§0.7)
  | { kind: "card"; template: "title" | "section" | "text" | "bullets" | "cta" | "outro";
      content: { heading: string; body?: string; bullets?: string[]; logo?: boolean } }
  | { kind: "still"; image:
        | { from: "asset"; asset: AssetId }
        | { from: "capture"; scenario: Scenario } }   // setup + navigate + screenshot. The shot lives in the take store
  | { kind: "media"; asset: AssetId; trim?: { inMs: number; outMs: number }; muted?: boolean };
```

**`auto` duration:**
- `recording`: the take after the `clips` track (speed-ups, cuts, **freeze frames** added where a caption needs more reading time than the action takes).
- `still` / `card`: the reading time of the text and captions (about 180 words per minute), **2s minimum**.
- `media`: the trimmed length.

**Anchors for non-recording scenes:** `card`, `still` and `media` have no steps, so anchors (§4) also accept `{ scene: "start" | "end"; offsetMs?: number }`.

**Status is computed, not stored** (so it can't drift from reality):
```
recording / still-capture:
  draft     → some steps aren't grounded yet
  grounded  → every target is resolved, but no take matches the current scenario
  ready     → a take exists for key(scenario) (§0.7)
  stale     → the scenario changed since the take, OR a health check (`expect`) found the UI drifted
  failed    → the last run errored (the reason is kept: scene, step, cause)
card / media / still-asset: always ready
```

Rule of thumb: **one scene = one idea, 5–30s**.

**Project on disk.** The folder contains **objects only**, so it can live anywhere, including the user's app repo:
```
q4-release.kiframe/
  project.json              orgId, sequence, canvas layout (v0.1), presets, outputs, style overrides
  scenes/<sceneId>/
    scene.json              Scene without the big parts
    scenario.yaml           recording / still-capture only
    composition.json
  assets/<sha256>.<ext>     USER-PROVIDED sources only (uploaded images, imported media, logos)
  exports/<exportId>.json   which version + which takes produced which export (the files themselves live wherever the user saved them)
```
**Takes are not in the project folder.** They live in the app's **take store**, in the protected app-data directory, encrypted at rest (§0.7, §3):
```
<app-data>/Kiframe/takes/<projectId>/<sceneId>/<takeKey>/
  frames.webm  events.jsonl  cursor.jsonl  shots/<stepId>.png  meta.json  pin.json?
```
Why outside the folder: takes are **heavy**, and they're **sensitive**, since raw frames aren't blurred (APPROACHES §7.4). They must never end up in git or in a folder shared by mistake.

### 0.7 Source vs artifacts: pinned and scratch takes (revised 2026-09-26)

**Principle (unchanged):** the project contains only **objects**. **Video only appears at export.**

**Correction:** a take **isn't a pure cache**, because it **can't be rebuilt from source**. It depends on the live app's state at recording time (UI, data, flags, date). Re-recording gives *a* take, not *the* take. So we distinguish:

| | **Pinned take** | **Scratch take** |
|---|---|---|
| What | A take referenced by an **export**, a **named version**, or the scene's **current composition** | Every other take (older re-records, failed attempts, previews) |
| Eviction | **Never automatic.** Only an explicit "delete" by the user (with a warning) | LRU with a size limit, plus a "Free up 2.3 GB" button |
| Versioned in git | No (heavy, sensitive). Referenced by **`takeKey`** from `composition.json` and `exports/*.json` | No |

**The take key:** `takeKey = hash(scenario + target environment + capture settings) + recordedAt`.
- The composition references the take it was generated from: `composition.take = { key }`.
- A re-record produces a new take. The generators then **rebase** the composition: `auto` segments are regenerated, `manual` ones are kept (orphans flagged), and `composition.take.key` points to the new take. The previous take stays pinned if an export or a named version references it, and otherwise becomes scratch.

**Honest contracts:**
- **Re-export exactly:** only if the export's takes are still pinned, which is the default.
- **Restore an old version:** if its takes are still pinned, the restore is **faithful**. If not (the user deleted them), the scenes are shown as **"re-shoot on current UI"**. The old scenario may need **healing** before it grounds on today's UI, and old manual segments may be flagged as orphans. The user is told before anything happens.
- **Preview:** instant if a take exists for the current scenario. Otherwise the scene is `stale` and shows its last take with a "stale" badge, or a storyboard if none exists, until it's re-recorded.
- **App unreachable** (staging down): nothing is lost. Pinned takes still preview and export, and only re-recording is blocked, with a clear message.

| Source (versioned, in the project folder) | Artifacts (take store, not versioned) |
|---|---|
| `project.json`, `scene.json`, `scenario.yaml`, `composition.json` | takes: frames, events, cursor, shots |
| user assets (uploaded images, imported media, logos) | previews, posters |
| `exports/*.json` (version + take keys used) | the exported files themselves (can be re-rendered from pinned takes) |

**Later track (option C): the take as an object (DOM capture).** Record the DOM and its changes (rrweb-style) instead of pixels, and render frames at export: any resolution, blur by selector, lightweight. Risky with canvas, WebGL, embedded video and cross-origin iframes. A spike after v0. The model allows it (`capture.mode: "dom"`), and the renderer reads the base through one interface.

---

## 1. Three layers

```
  scenario.yaml          take (take store)              composition.json
 ┌──────────────┐      ┌───────────────────────┐      ┌──────────────────────────┐
 │ 1. SCENARIO  │ run  │ 2. TAKE (capture)     │ gen  │ 3. COMPOSITION (edit)    │ render
 │ intent       │─────▶│ facts: what happened  │─────▶│ tracks of segments       │───────▶ video / guide
 │ setup,       │      │ frames.webm           │      │ camera, cursor, captions,│
 │ steps,       │      │ events.jsonl          │      │ masks, callouts, clips   │
 │ captions     │      │ cursor.jsonl, shots   │      │ + style                  │
 └──────────────┘      └───────────────────────┘      └──────────────────────────┘
   written by            written by the runtime         auto-generated by pure
   user + agent          (no LLM)                       generators, then edited by
                                                        user + agent
```

| Layer | Owner | Changes when | Cost to rebuild |
|---|---|---|---|
| Scenario | User + agent (chat) | The story changes | LLM (grounding / healing) |
| Take (pinned or scratch, §0.7) | Automation runtime | Re-record: scenario changed, UI drifted | Replay (about the scene's length + setup) |
| Composition | Generators + user edits | Style or edit changes | Seconds (render only) |

**Rule: the renderer reads only the composition and the take.** It knows nothing about Playwright, the LLM or the scenario.

---

## 2. Layer 1: Scenario (`scenario.yaml`, one per scene)

The format, refined with ideas from demo-machine, VHS and Maestro. **The scenario describes one scene only**, and what's shared moves up to the project.

**Project level** (`project.json`, shown as YAML for readability):

```yaml
environment: staging             # org-level environment (APPROACHES §10c): URL, sandbox flag, pre-approvals
target:
  kind: web                      # web (v0) | electron (v0.1) | tauri (later)
  viewport: { width: 1440, height: 900, deviceScaleFactor: 2 }
defaults:                        # like VHS `Set`: global, separate from actions
  pacing: { cursor: natural, typing: human, settleMs: 400 }
  camera: auto                   # generators decide framing unless a step overrides (§2b)
presets:                         # shared off-camera setups (§0.4)
  login-as-manager:
    session: true                # run once per recording batch, then reuse its storageState
    steps:
      - action: goto
        url: /login
      - action: type
        target: { by: label, name: "Email" }
        value: "{{secrets.acme_staging.email}}"          # vault NAME only (APPROACHES §7.4)
        instant: true                                    # off camera: no human typing needed
      - action: type
        target: { by: label, name: "Password" }
        value: "{{secrets.acme_staging.password}}"
        instant: true
      - action: click
        target: { by: role, role: button, name: "Sign in" }
interrupts: [ … ]                # §2b
hide: [ … ]                      # §2b
redaction:
  selectors: [ ".customer-email" ]
  secrets: auto                  # anything filled from the vault, and any occurrence of it on screen, is masked
```

**Scene level** (`scenes/create-project/scenario.yaml`):

```yaml
version: 1
# overrides:                     # optional: any project-level setting (viewport, pacing…)
setup:                           # off camera, like VHS `Hide`. Makes the scene self-contained
  - preset: login-as-manager     # session preset → skipped if the batch is already logged in
  - action: goto
    url: /projects
  - ensure:                      # the ONLY idempotency primitive: declarative, not a condition
      absent: { by: role, role: link, name: "Q4 Launch" }   # if present → run this scene's teardown, then re-check
steps:
  - id: open-new                               # stable ID: everything downstream anchors to it
    action: click
    target:
      intent: "New project button"             # natural language (from chat)
      by: role                                 # grounded locator (agent fills it in)
      role: button
      name: "New project"
      fallbacks: [ { by: text, text: "New project" } ]
      fingerprint: fp/open-new.png             # crop, used for self-healing
    caption: "Click New project."                         # video (short, marketing tone)
    instruction: "Click **New project** at the top right." # guide (precise, imperative)
  - id: name-project
    action: type
    target: { intent: "Project name field", by: label, name: "Project name" }
    value: "Q4 Launch"
    caption: "Give it a name."
    instruction: "Type your project's name in the **Project name** field."
    camera: target                             # frame the field (§2b)
  - id: done
    action: waitFor                            # like VHS `Wait`: a condition, not a sleep
    until: { text: "Project created" }
    caption: "Your project is ready."
    hold: 1500                                 # presentation beat (never sped up)
teardown:                        # off camera, after recording (and when `ensure` needs it)
  - action: click
    target: { by: role, role: link, name: "Q4 Launch" }
  - action: click
    target: { by: role, role: button, name: "Delete project" }
    risky: true                  # needs confirmation, unless pre-approved on a sandbox environment
```

The scene's title, notes, duration and transition live in `scene.json` (§0.6). The scenario is only about **what happens in the app**.

Principles:
- **Step `id`s are stable.** The take and the composition refer to steps by ID, never by index.
- **A target keeps both the intent and the grounded locator.** The intent is used to heal the locator when it breaks.
- **Wait on a condition**, never a fixed sleep. `hold` and `pause` are presentation choices, not synchronization tools.
- **`caption` ≠ `instruction`:** the same step, told two ways (to watch vs to follow).
- **`ensure` is the only thing that resembles a condition,** and it's declarative ("this must be true before filming"). If the runtime can't make it true, the scene fails with a clear message.

## 2b. Step vocabulary: app actions and camera directives

### Two separate questions
1. **What happens in the app?** → `action`. The runtime executes it through Playwright.
2. **How do we show it?** → `camera`, `emphasis`, `hold`. **No effect on the app.** Generators turn them into composition segments (§4.1).

"Zoom" is therefore **not an action**. It's a presentation directive attached to a step, or a segment edited in the composition.

### Inspirations
| Source | What we take |
|---|---|
| **Playwright** API | The base vocabulary (`click`, `fill`/`pressSequentially`, `press`, `hover`, `selectOption`, `setInputFiles`, `dragTo`, `mouse.wheel`, `waitFor`) |
| **Maestro** (mobile tests as YAML flows) | The closest to a readable YAML: `tapOn`, `inputText`, **`scrollUntilVisible`**, **`runFlow`** (= our presets), `assertVisible` |
| **Selenium IDE** / **demo-machine** | Command lists that proved sufficient in practice |
| **VHS** | `Hide/Show` (= our `setup`/`teardown`), `Wait` on a condition, `Sleep` as a presentation beat |
| **Screen Studio / Cap / OpenScreen / Screenize** | Camera: `Auto` vs `Manual{x,y}`, follow-cursor with dead zone, spring easing |
| **Arcade / Supademo** (documented features) | Per step: a **hotspot** on the target + a **callout** + **pan & zoom** onto a region |

### App actions (v0)
| Action | Key params | Notes |
|---|---|---|
| `goto` | `url` | Relative to the environment's URL |
| `click` | `target`, `button?`, `count?` (2 = double-click), `modifiers?` | Also covers checkboxes, custom menus and dropdowns |
| `hover` | `target`, `hold?` | Shows tooltips and menus |
| `type` | `target`, `value`, `clear?`, `submit?` (Enter at the end), `instant?` (off camera) | Human typing by default. `value` can be `{{secrets.x}}` |
| `press` | `keys` (`"Mod+K"`, `"Enter"`) | `Mod` = ⌘ on Mac and Ctrl elsewhere. Can show a keystroke overlay |
| `select` | `target`, `option` | Native `<select>` only (custom dropdowns = `click`s) |
| `scroll` | `to: target` \| `by: {y}` \| `until: target`, `within?: target` | Long pages and lists. **Smooth synthetic scroll** (eased) |
| `drag` | `target`, `to: target \| {dx,dy}` | Kanban, sliders, reordering |
| `upload` | `target`, `file` (project asset) | The OS dialog isn't filmed. We show the result |
| `waitFor` | `until: { visible \| hidden \| text \| url \| networkIdle }`, `timeout?` | Synchronization, never a fixed sleep |
| `pause` | `ms` | **A presentation beat**: let the viewer look. Never sped up |
| `expect` | same conditions as `waitFor` | **Off-camera check** of the state. Used by grounding and **health checks** (drift → `stale`) |

Setup/teardown-only directives: `preset`, `ensure` (§2).

A `risky: true` flag goes on any step that deletes, sends, pays or invites. It needs confirmation unless pre-approved on a sandbox environment (APPROACHES §7.2–7.3). The agent sets it, and the runtime also detects obvious cases (buttons named Delete/Send/Pay).

**Implicit behaviors (runtime, not actions):**
- the **interrupt check** before each step (see below)
- cursor travel to the target before every pointer action (Bézier + Fitts)
- **auto-scroll into view** (visible and smooth) if the target is off screen
- settle after each action (`settleMs` + DOM stable)
- a **new tab or popup** opened by a click is followed automatically

**Deliberately excluded:**
- `evaluate` (arbitrary JS): never in steps. In `setup` only, with confirmation, never with secrets, and never on a page where a secret was filled (APPROACHES §7.4).
- touch and swipe, window resizing, native OS dialogs.

**Common fields on every step:** `id`, `action`, `target?`, `caption?`, `instruction?`, `camera?`, `emphasis?`, `hold?`, `cursor?: "show" | "hide"`, `speed?`, `keystrokes?`, `risky?`.

### Decisions: no conditions in steps; interruptions handled at project level (2026-09-26)
**No `if` / `repeat` in steps.** A demo must be **deterministic**: the same scenario gives the same film. Conditions make scenarios harder to read, harder to heal, and produce different videos from run to run. If something needs repeating, the agent writes out the steps. (`ensure` in setup is the one declarative exception, §2.)

The real need behind `if` is **unpredictable interruptions**: cookie banners, "What's new" modals, chat widgets, NPS surveys. Two project-level mechanisms, both off camera:

```yaml
# project.json
interrupts:                      # checked before each step; handled off camera
  - when: { by: role, role: dialog, name: "Cookie preferences" }
    do: { action: click, target: { by: role, role: button, name: "Accept all" } }
  - when: { text: "What's new" }
    do: { action: press, keys: "Escape" }
hide:                            # removed from the frame with injected CSS (display: none)
  - "#intercom-container"
  - ".nps-survey"
```
- **Mechanism (revised):** *not* Playwright's `page.addLocatorHandler()`. That handler fires inside actionability checks, which can be between a `mouse.move()` and a `mouse.down()`, and Playwright warns that the mouse is then left in the wrong position. That's exactly our human-cursor pattern. Instead, **the runtime runs an explicit interrupt check before each step's cursor travel**. If an interrupt matches, it runs its `do`, marks the time span, and **re-plans the cursor path**. The screencast keeps running, and the marked span becomes a **cut** in the `clips` track, so it's invisible in the video.
- Interrupts that appear **mid-step** (rare) make the step fail and retry once after handling them.
- The agent proposes interrupt and hide rules itself when it hits them during grounding. Rules can be **shared at org level** (a bank of known cookie banners, APPROACHES §10c).

**Keystroke overlay** is a **style** option, `style.keystrokes`:
- `"shortcuts"` **(default)**: shown only for `press` with a modifier (`Mod+K`, `Shift+Enter`), which the viewer couldn't guess.
- `"all"`: every key, including Enter and Tab (useful for keyboard tutorials).
- `"off"`.
- Regular typing is never shown in the overlay, since it's visible in the field. Per-step override: `keystrokes: show | hide`.

### Camera directives
**Our advantage over Screen Studio:** they only know **cursor coordinates**, but we know **the DOM element** the step acts on. So the default is **"frame the element"**. That's semantic, independent of resolution and aspect ratio, and survives a re-record.

```yaml
camera: auto                               # default: the generator decides (§4.1)
camera: wide                               # full screen, no zoom
camera: target                             # frame this step's target (+ padding), scale computed to fit
camera: { follow: cursor }                 # follow the cursor (dead zone + spring): drag, long movements
camera: { frame: { by: role, role: region, name: "Revenue chart" } }   # frame ANOTHER element
camera: { frame: { rect: [0.55, 0.1, 0.4, 0.35] } }                    # a manual region (normalized)
camera: { frame: target, scale: 2.5 }      # force the zoom level (still capped, see below)
camera: { …, until: done }                 # keep this framing until step `done` (spanning several steps)
```

| Mode | When | Becomes (composition) |
|---|---|---|
| `auto` | By default | Generated `CameraSegment`s (`source: auto`) |
| `wide` | Context, navigation, scroll | scale 1 |
| `target` | Click, type, select: "look here" | `focus: { mode: "rect", rect: <target rect from the events> }` |
| `follow: cursor` | Drag, long movements | `focus: { mode: "follow-cursor" }` |
| `frame: <locator>` | "Look at the chart that just updated" | rect of that element, **resolved during capture** and logged in the events |
| `frame: { rect }` | Canvas, areas without an element | normalized manual rect |

`emphasis` (`highlight` | `spotlight` | `none`) works the same way: it targets `target`, another element, or a rect, and becomes a `MaskSegment` of kind highlight or spotlight.

**Rules to keep it nice to watch** (enforced by the renderer):
- spring transitions (no instant jump unless `ease: instant`)
- a minimum hold per framing (about 1.3s)
- zoom out during a `scroll` (unless `follow`)
- **max scale = source resolution / output resolution**. With DPR 2 capture of a 1440×900 viewport (2880×1800 source) into 1080p, that's about 1.7× at full sharpness. Beyond that, allow up to 2.5× with a visible-softness warning in the editor
- in `vertical`/`square` presets, framing is tighter automatically

---

## 3. Layer 2: Take (capture facts)

One replay of a scene produces a **take** in the take store (§0.6):

```
<app-data>/Kiframe/takes/<projectId>/<sceneId>/<takeKey>/
  frames.webm          raw video at DPR 2, WITHOUT a cursor (the cursor is drawn at render time). NOT blurred → sensitive, encrypted at rest
  events.jsonl         timestamped semantic events
  cursor.jsonl         cursor samples (real mouse positions, so hover states happened in the app)
  shots/<stepId>.png   frame at each step_start (storyboard + guide screenshots)
  meta.json            viewport, DPR, fps, scenario hash, environment, app URL, recordedAt, Kiframe version
  pin.json             present if pinned: which exports / versions / compositions reference it
```

```ts
// All coordinates normalized 0..1 relative to the viewport, so they're resolution independent.
type NRect  = { x: number; y: number; w: number; h: number };
type NPoint = { x: number; y: number };

type TakeEvent = { t: number; stepId: string } & (   // t = ms from the first frame (screencast timestamps)
  | { kind: "step_start" | "step_end" }
  | { kind: "click"; point: NPoint; rect: NRect; button: "left" | "right" }
  | { kind: "type_start" | "type_end"; rect: NRect; secret?: string }  // secret NAME only
  | { kind: "key"; key: string }                                       // for keystroke overlays
  | { kind: "scroll"; delta: NPoint }
  | { kind: "navigate"; url: string }                                  // URL passed through the secret scrubber
  | { kind: "settled" }                                                // network idle + DOM stable
  | { kind: "frame_target"; ref: string; rect: NRect }                 // rects for `camera.frame` / `emphasis` locators
  | { kind: "sensitive"; id: string; rect: NRect; why: "secret-field" | "secret-text" | "redaction" }  // re-logged when it moves
  | { kind: "interrupt"; rule: string; until: number }                 // span to cut (§2b)
);

type CursorSample = { t: number; p: NPoint; pressed: boolean; css?: string };  // css = computed `cursor` style (I-beam, pointer…)
```

Capture decisions:
- **Capture through `page.screencast` / CDP at deviceScaleFactor 2.** `onFrame` provides a timestamp per frame ([docs](https://playwright.dev/docs/api/class-screencast)). Events and cursor samples use the same clock, so no marker frame is needed (keep a "clapperboard" frame only as a debugging fallback).
- **The runtime plans the cursor path** (Bézier + Fitts, like ghost-cursor) and **moves the real mouse** along it, so hover effects happen in the app. It logs each sample with the element's computed `cursor` style, so the renderer can draw the right shape (pointer, I-beam, custom). The frames contain **no cursor**.
- **Sensitive rects** come from two sources: fields filled from the vault, and a **DOM-text scan** at each frame that finds secret values (or their variants) shown elsewhere on the page (APPROACHES §7.4).
- **Frame-exact option (later):** virtual-time capture (`beginFrame`, deterministic mode). Slower, and support in the new headless mode is unverified.
- **A take is immutable.** A re-record writes a new take (§0.7).

---

## 4. Layer 3: Composition (the edit)

Modeled on Cap's `TimelineConfiguration` (parallel typed tracks) and OpenScreen's `ZoomRegion`:

```ts
type Composition = {
  version: 1;
  take?: { key: TakeKey };         // the take the auto segments were generated from (recording / still-capture only)
  style?: Partial<Style>;          // scene-level overrides (output format comes from the Output, §0.5)
  tracks: {
    clips:      ClipSegment[];     // how source time maps to output time
    camera:     CameraSegment[];   // zoom and pan
    cursor:     CursorSegment[];   // visibility, click effects
    captions:   CaptionSegment[];
    masks:      MaskSegment[];     // blur/pixelate (sensitive) or highlight/spotlight
    callouts:   CalloutSegment[];  // arrows, text boxes, step badges
    keystrokes: KeystrokeSegment[];
    // later: audio (voiceover, music)
  };
};

// Every segment shares the same base
type SegmentBase = {
  id: string;
  source: "auto" | "manual";   // regeneration replaces auto segments and keeps manual ones
  at: Anchor;                  // when it starts
  until: Anchor;               // when it ends
};

// Segments are anchored to STEPS/EVENTS, not to absolute milliseconds.
// A re-record shifts every timing, but "zoom on step name-project" still makes sense.
type Anchor =
  | { step: string; edge: "start" | "end"; offsetMs?: number }
  | { event: string; offsetMs?: number }            // e.g. the click in a step
  | { scene: "start" | "end"; offsetMs?: number }   // card / still / media scenes
  | { ms: number };                                 // escape hatch: absolute source time

type ClipSegment = SegmentBase & (
  | { mode: "speed"; speed: number }   // 1 = real time. Idle gaps and network waits → e.g. 4
  | { mode: "cut" }                    // removed from the output (setup, interrupts, very long waits)
  | { mode: "freeze"; ms: number }     // hold the frame at `at` for ms (caption reading time)
) & { reason?: "idle" | "network" | "setup" | "interrupt" | "reading" | "user" };

type CameraSegment = SegmentBase & {
  scale: number;                               // 1 = full frame, 2 = 2x zoom (capped, §2b)
  focus: { mode: "follow-cursor" } | { mode: "rect"; rect: NRect } | { mode: "point"; p: NPoint };
  ease?: "spring" | "instant";
};

type CaptionSegment = SegmentBase & { text: string; position?: "bottom" | "top" | "near-target" };

type MaskSegment = SegmentBase & {
  kind: "blur" | "pixelate" | "highlight" | "spotlight";
  target: { sensitiveId: string } | { frameRef: string } | { rect: NRect };  // ids follow the element as it moves
};
```

**Time model (priority rules).** `clips` maps **source time → output time**, and every other track is anchored in source time. Generators and the renderer apply these rules in order:
1. **A caption window, a `pause` or a `hold` is never sped up or cut.**
2. Interrupt spans and setup are **cut**.
3. Remaining idle time over 1.5s and network waits are **sped up** (e.g. 4×).
4. If a caption needs more reading time than its step lasts in output time, a **freeze** is inserted at the end of the step. **This is a composition change, never a scenario change**, so it doesn't alter the take key and doesn't force a re-record.

Why each choice:

| Choice | Why |
|---|---|
| **Parallel typed tracks** | Every tool that does this well (Cap, OpenScreen, Screenize) ended up with this model. Each track has its own semantics and generator |
| **`source: auto \| manual`** | You can regenerate after a re-record without losing the user's tweaks (OpenScreen does this) |
| **Anchors to steps/events** | Edits survive a re-record, even when all the timing moves. This is what makes self-healing demos possible |
| **Normalized coordinates** | Re-framing to 9:16 and exporting at any resolution without changing the data |
| **Camera stores intent (focus + scale), not keyframes** | The renderer's spring turns intent into smooth motion. Users can't create jerky zooms, and the data stays small and easy for the LLM to edit |
| **Cursor comes from samples, not pixels** | You can restyle it (size, shape from CSS, click ripple), re-smooth it or hide it |
| **Explicit clip modes (`speed`/`cut`/`freeze`)** | Serializable (no `speed: ∞`), and the rules above are easy to check |

### 4.1 Generators (pure functions, no LLM)

```
generate(scenario, take, style) → auto segments
```
- **camera:** from each step's `camera` directive. With `auto`, group nearby actions into clusters, and give each cluster a `target`-style framing with timing rules (≥600ms to settle in, ≥1.3s hold, a lead-in that grows with distance, from programatic-demo). Zoom out on scroll and navigation.
- **clips:** apply the time-model rules above (cut, speed-up, freeze).
- **captions:** one segment per step caption, anchored to the step. Reading time is guaranteed by rule 4.
- **masks:** one blur segment per `sensitive` event (secret fields, secret text found on screen, redaction selectors). One highlight/spotlight per `emphasis`.
- **cursor:** click ripple on each click. Hidden in cut spans.

Regenerating (for example after a re-record) = delete the `auto` segments, run the generators, keep the `manual` ones, and set `take.key` to the new take. If a manual segment's anchor no longer exists, it's **flagged as orphaned**, never silently dropped.

### 4.2 How the agent edits it
The chat ("zoom more on the name field", "make step 3 faster") maps to **small, typed patch tools**, never to rewriting the JSON by hand:
```
composition.setCamera({ step: "name-project", scale: 2.2 })   → creates or updates a manual segment
composition.setSpeed({ step: "open-new", speed: 1.5 })
composition.setCaption({ step: "done", text: "…" })
composition.describe()   → a compact text view of the timeline, for the LLM
```

---

## 5. Rendering: one renderer for preview and export

`renderFrame(composition, take, tOut) → pixels` is **deterministic and random-access**: any frame can be computed without rendering the ones before it. That's required for scrubbing the preview, and for the export to match it.

Per frame:
1. Map output time to source time using the `clips` track, and decode that source frame.
2. **Camera:** the springs are **analytic** (a closed-form critically damped spring, evaluated from the start of the active camera segment with the previous segment's end state as its initial condition). There's no simulation state carried from frame to frame, so seeking anywhere gives the same result as playing through.
3. Draw the frame inside a styled window (padding, radius, shadow, background). For desktop targets, composite a fake title bar.
4. Masks (blur follows the tracked rects) → cursor (smoothed samples, shape from CSS, click effects) → callouts → captions.
5. Export: step through frames → WebCodecs encoder → Mediabunny mux → MP4/WebM. The guide is rendered separately: shots + highlight boxes + text → Markdown/HTML/PDF.

Renderer options:

| Option | License | Notes |
|---|---|---|
| **Own compositor on WebGL (PixiJS)** | MIT | Our scene is narrow: one video layer, a camera transform and overlays. Full control, real-time preview in the Electron UI. OpenScreen (Electron + PixiJS) proves the approach |
| Remotion | Free for companies of **≤3 employees** (including automation); "Automators" usage-based license beyond ([pricing](https://www.remotion.dev/docs/license/pricing)) | The most mature. A viable fallback while small. Less natural for a data-driven, random-access editor with our own spring camera |
| Revideo | MIT | Scenes are TS code. Worth a spike if the compositor turns out to be more work than expected |
| Plain ffmpeg filtergraphs | LGPL/GPL builds | Fine for cuts and speed changes. Too awkward for springs, cursor drawing and rich overlays |

**Recommendation:** our own **PixiJS compositor**, with **the export done in the frontend** (Electron's Chromium).

**Video in the frontend: the pipeline**
```
take frames.webm ──demux (Mediabunny)──▶ VideoDecoder (WebCodecs) ──▶ exact frame at t
                                                              │
     composition ──▶ PixiJS draws the frame (camera, cursor, masks, captions) on a canvas
                                                              │
          new VideoFrame(canvas, {timestamp}) ──▶ VideoEncoder (WebCodecs, hardware when available)
                                                              │
                                           Mediabunny mux ──▶ .mp4 / .webm
```
- **WebCodecs** (`VideoEncoder`/`VideoDecoder`): native browser API. It uses the OS's hardware encoders where available (VideoToolbox, Media Foundation). H.264, VP9, AV1. Frame by frame, faster than real time.
- **Mediabunny** (**MPL-2.0**, successor of `mp4-muxer`/`webm-muxer`, [repo](https://github.com/Vanilagy/mediabunny)): reads and writes MP4/WebM in JS. MPL-2.0 is file-level copyleft: fine to use in a closed app, but modifications to its own files must be shared.
- **Frame-exact decoding through WebCodecs**, not `<video>.currentTime`, whose seeking isn't precise.
- **GIF (later):** `gifenc` (JS), or WebP/AVIF animations.
- **Not chosen as the main path:** `MediaRecorder` + `canvas.captureStream()` (real time only, not frame-exact), `ffmpeg.wasm` (slow and heavy, a last-resort fallback).

**Why this matters:**
1. **Preview = export:** the same code (PixiJS + decoder + analytic springs) plays in the editor and produces the file.
2. **Fewer native binaries:** export needs no ffmpeg binary. (Capture may still use an encoding step, decided in Phase 0, APPROACHES §6.)
3. **The door stays open to a web version** of the editor. Only capture needs the local Node + Playwright side.

**Watch out for:**
- **Codec support varies:** check `VideoEncoder.isConfigSupported()` and fall back (H.264 → VP9/AV1). H.264 on Linux isn't guaranteed.
- **Headless CLI / CI:** **Playwright's bundled Chromium has no H.264**, so the compositor must run in **Electron's Chromium** (or `channel: "chrome"`), with a VP9/AV1 fallback (APPROACHES §10.1).
- **GPU memory:** `VideoFrame.close()` on every frame, and backpressure on `encodeQueueSize`, especially in 4K.
- **Audio** (voiceover later): `AudioEncoder`. Opus is supported everywhere; AAC depends on the platform.

**Split:** **capture = backend** (Node + Playwright + CDP), **composition + export = frontend** (Chromium: PixiJS + WebCodecs + Mediabunny).

---

## 5b. Versioning and history

### Constraints
- **Heavy binaries:** takes live in the take store (§0.7), outside history. Only user assets need care.
- **Frequent, fine-grained edits,** many made by the agent. Users must be able to say "undo what the agent just did".
- **Non-technical users** must never see "commit", "merge" or "detached HEAD".
- **Technical users** want demos as code: diffs, branches, GitHub, CI.
- **Traceability:** "which version produced this exported video?"

### Options considered
| Option | Pros | Cons |
|---|---|---|
| **A. Plain git in the project folder** | Standard tooling, diffs, branches, GitHub remote, CI | A `.git` inside a folder that lives in the user's app repo = a **nested repo**. Git concepts show through |
| **B. Snapshot copies** | Trivial | Wasteful, no diffs |
| **C. Operation log / event sourcing** | Precise undo, natural fit for agent tool calls | Must build it ourselves. The log grows. Schema migrations are painful |
| **D. CRDT** (Yjs/Automerge) | Real-time collaboration + history | Heavy, and collaboration isn't v0. Harder to get git-friendly files |

### Recommendation: layered, with a **hidden git history stored outside the project folder**
1. **Undo/redo (in memory):** an operation stack for fine-grained UI edits. Not persisted as history.
2. **Checkpoints = automatic commits** in a **hidden repo whose `GIT_DIR` lives in app data** (`<app-data>/Kiframe/history/<projectId>.git`), with the **project folder as its work tree**. The project folder itself contains **no `.git`**, so it can sit inside the user's own repo without nesting. One commit at each **meaningful moment**:
   - each **agent turn** ("Agent: zoom 2.2x on *name-project*"), which gives "revert the agent's last change"
   - each **take recorded** (the composition's `take.key` changes), each **export**, and each **"Save version"** (a named version = a tag, which **pins** its takes)
   - an idle save (after 30s without edits) for manual edits
3. **Nothing heavy goes into history:** takes are in the take store. User `assets/` are content-addressed and small, so they're committed.
4. **Take store eviction:** **scratch** takes follow an LRU with a size limit and a "Free up 2.3 GB" button. **Pinned** takes are never evicted automatically (§0.7).
5. **Exports are traceable:** each export writes `exports/<id>.json` (commit + output + take keys + renderer version), and **pins** its takes. So "which version is this video?" always has an answer, and re-export is exact while the takes stay pinned.
6. **Git-friendly files:** one scene per file, stable IDs, sorted keys, pretty-printed JSON/YAML.

**Limit to state clearly:** reverting history restores **objects**, not the live app. If the agent's last turn **created data in the app** (grounding runs steps), a revert doesn't delete it. The UI warns when a revert crosses app actions ("this won't undo what was created in Staging"), and the scene's `teardown` / `ensure` handles the cleanup.

### What the user sees
- **Everyone:** a **History** panel (a timeline of checkpoints with readable labels, grouped by session), "Restore this version", and named versions ("v1 sent to marketing"). **Compare** (side by side) comes later and needs pinned takes on both sides.
- **Technical users (opt-in):** they commit the project folder with **their own git**, in their app repo, like any other files. CI re-runs with the headless CLI (APPROACHES §10.1). The hidden history stays a local convenience.
- **The agent:** `history.list()`, `history.diff(a, b)` (a readable summary: "step 3 caption changed, zoom added on step 5"), `history.restore(id)`.

### Later
- **Variants = branches** ("try a faster version"), shown as "Duplicate as a variant".
- **Team sync:** the project folder through a git remote + a shared take store (content-addressed, encrypted), as a paid option. If real-time multi-user editing becomes a need, evaluate a CRDT then (cooldown's `use-ws-collab.ts` is worth checking).

## 6. Open questions
1. **Cursor shapes:** we log the computed CSS `cursor` per sample (§3). Is that enough for custom cursors (image URLs), or do we fall back to a standard pointer?
2. **Scroll:** smooth synthetic scroll is the default (§2b). Do some apps (virtualized lists, scroll-triggered animations) need real wheel scrolling? Test in Phase 0.
3. **Take encoding:** WebM (VP9) from screencast frames vs an image sequence. Disk use vs quality vs encoding cost. Decide in Phase 0.
4. **Multi-take scenes:** one scene built from several captures (two apps, two user roles)? Probably later.
