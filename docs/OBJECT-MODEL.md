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
- Each scene can have an off-camera **`teardown`** that removes what it created. It's pre-approved on sandbox environments. A stopped run doesn't run it: the scene's next `ensure` cleans what it left (APPROACHES §0).
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
| ~~`card`~~ | — | **Replaced by HTML pages (§0.11, designed 2026-10-05)**: a recording of a page from `pages/`, the six templates (title, section, text, bullets, CTA, outro) shipped as page templates | — | — | Intro, "Step 2: Invite", "Try it now" |
| `still` | v0.1 | An image: **captured from the app by the agent** (self-updating) or uploaded | Fixed, or auto | ✅ if captured | "Here's the dashboard", with a slow zoom + callouts |
| `media` | v0.1 | An imported file (video or animated GIF) | Media length, trimmed | ❌ | Founder clip, logo animation |
| *(later)* `terminal`, `avatar` | — | VHS-style terminal, a talking head (an HTML slide is a page now: §0.11) | — | — | — |

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

**Implemented (M1-1, `packages/schema`):** `Project` (`project.json`), `Scene` (`scene.json`), `OrgSettings` (brand kit, style, environments, rule bank, LLM policy), `UserPreferences`, `Style` / `StyleOverride`, and `resolveProjectConfig` (org + project → the `ProjectConfig` the runtime reads: URL from the environment, org rules before the project's). Differences from the sketch above: a scene's scenario and composition are separate files (`scene.json` holds `source: { kind: "recording" }`), a guide output lists its `formats`, v0 has only the `recording` / `card` kinds and `video` / `guide` outputs, and every document has a `version` with migrations on read (a newer version is refused).

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
<app-data>/Kiframe/takes/<projectId>/<sceneId>/take-<time>-<id>/   (looked up by meta.takeKey)
  frames.webm  events.jsonl  cursor.jsonl  shots/<stepId>.jpg  meta.json
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

**The take store, as built (M1-8, 2026-10-04): encryption at rest.** One key for the store (32 random bytes) in the OS keychain (the vault's keyring backend, the app's own entry), made on first use; one that doesn't read is never replaced. `frames.webm`, `events.jsonl`, `cursor.jsonl` and `shots/` are AES-256-GCM (a fresh IV per file: `magic | iv | ciphertext | tag`); `meta.json` stays plain (listing needs no key). The recorder writes into its private staging folder; the take is encrypted as it settles (each file written whole and synced, then swapped in), before it counts; the keychain refusing the key: the take is deleted, never kept plain. At the app's start, any placed take with a plain file (a crash partway, a take from before) is sealed, take by take (one that fails is said; a keychain refusal is said and nothing is touched). The store's writes run one at a time (a take settling, a take sealed). Readers decrypt in memory (the frames read off the main thread); another key, or a changed file: "its take didn't read: record it again". Stated gaps: plaintext exists in staging while a scene records; deleting isn't a secure wipe on SSDs; a take store moved to another machine needs its key.

**Eviction and vanished projects, as built (2026-10-04).** Pins are **derived, never stored**: a take is named when a composition of one of its project's folders names it, read from the folders themselves (read only, in a worker thread, 5 s per folder) each time. The app keeps an index of the folders it opened per project id, with the device each was on. **Nothing is deleted for being gone** (decided by the user, 2026-10-04): a project can't be told deleted from moved and not opened since, so a vanished project's takes only stop counting as named.
- **Scratch eviction.** After each recording (coalesced) and at the app's start, when the whole store is over **5 GB**: scratch takes beyond it are deleted, a vanished project's first, then least recently played (a `used` time, else the recording's). Never evicted: a take a folder there names; any take of a project with a folder that can't be read now (unknown, unplugged, a folder that times out), not in the index, or open in the app with a folder gone (an open project whose folders are all there is evicted like any other); of a scene that didn't read (a broken part, or a sequence scene whose folder is missing); whose meta doesn't read; recorded or played within 24 hours; and, unless its project vanished, the newest of its scene.
- **Under the lock.** Every counted project is asked again, before anything goes, whether its folders are as the pass read them (opened from a new place meanwhile, or open now: none of its takes goes), and each take whether it's still there and not played since; then it's moved aside under the lock and deleted after it, asynchronously (`sweep` finishes a deletion cut short). A project that changed stops counting: its scratch never makes another project's go.
- **Gone and vanished.** A folder is gone only when the folder itself isn't there ("no such file", nothing else), its own parent is there on the device the project was on, and no git working tree holds it. Anything else is unknown: a folder still there in any form (its project file missing, another project in it, its own repo on another branch, unreadable), a parent missing too (a sync root signed out, a renamed parent), another device (unplugged). A folder that doesn't answer in 5 s (15 s for a new worker's first) is unknown, and then every folder is for 10 minutes with no new worker. Every folder gone: the project vanished. Some gone, the rest there: the ones there name (a gone copy names nothing).
- **The index** is written whole and synced, its backup the same content (never a change behind); a file lost or broken is read from its backup; neither reading (both broken or missing; a read error writes nothing), both are kept aside (`.broken`) and the index starts again (a project not in it keeps every take).
- **Cost.** Nothing is read while the whole store is under the budget; then only projects with a take out of the grace have their folders read, and only takes that can go count as scratch: their projects' takes, never a scene's newest nor a changed project's (less evicted, never more). A take's meta and play time are read once and kept (read again when its meta file is replaced).

**Later track (option C): the take as an object (DOM capture).** Record the DOM and its changes (rrweb-style) instead of pixels, and render frames at export: any resolution, blur by selector, lightweight. Risky with canvas, WebGL, embedded video and cross-origin iframes. A spike after v0. The model allows it (`capture.mode: "dom"`), and the renderer reads the base through one interface.

### 0.8 How the agent builds a scene (as built)

One scene, three phases. The agent's own instructions say the same (`packages/studio/src/prompt.ts`).

1. **Explore and ground, on the live page.** The agent reads the page with `snapshot` (roles, labels, text, each element's ref) and tries actions with `run_step` / `run_steps`: each really runs on the page and says whether it worked and where the page ended. Nothing is written yet: every step is proven on the real app first ("ground every step"). It ends with the scene's teardown, run the same way, so the app is back as it was.
2. **Write the scene.** `save_scene` takes the whole `scenario.yaml` (setup, on-camera steps, teardown), checks it, and **replays it from scratch in a fresh browser** (no cookies, no storage). Saved only if the replay passes; otherwise the failure comes back and the agent fixes the YAML.
3. **Record.** `record_scene` films the saved scenario at human pace in another fresh browser; the composition (camera, cursor, captions) is generated from the take.

**The live page isn't fresh.** It's one browser session for as long as the project is open, shared by every scene: it keeps what the agent did (signed in, scrolled, a setting changed). The replay in phase 2 is what catches a scene that only works because of that state. Refs never reach the YAML (a ref becomes a locator that finds that element alone).

### 0.9 Apps a demo shows (designed 2026-10-05, not built)

**Today** a project has one `target`: `{ kind: web, url, viewport }`, and a scene never leaves that site (its address redirected to `www.` or `https` counts as it: `sameApp`). That's too narrow: Kiframe also targets **Electron** apps (v0.1) and **Tauri** (later, partial), and one demo can go from a web app to its docs site or its desktop app.

**Named apps, in `project.json`** (replacing `target`):

```json
"apps": {
  "app":     { "kind": "web", "url": "https://minmux.dev", "viewport": { "width": 1440, "height": 900 } },
  "docs":    { "kind": "web", "url": "https://docs.minmux.dev" },
  "desktop": { "kind": "electron", "launch": "/Applications/Minmux.app" }
}
```

- **A scene starts in one app**: the first, unless its scenario names another (`app: docs`).
- **Steps may go to any listed app, never elsewhere**: `goto: { app: docs, path: /install }`; a plain `goto: /x` stays in the current app; a link or a redirect landing on another listed app's site is fine. A page on an unlisted site is refused as today (the step says so; a scene can't be saved or recorded there).
- **Secrets stay tied to their app** (its origin, as now): one added for `app` is never typed on `docs`.
- **The list is the one place** that says everything a demo touches.

**The agent adds an app, the user approves** (decided by the user):

1. Exploring, the agent reaches an unlisted site (a link, a redirect, a step it needs). The step's result already says it's not the app's site.
2. It calls `add_app({ name, kind, url | launch, why })`. The user sees a card like a risky step's: *"Add docs.minmux.dev (web) to this project? Why: the install guide lives there."* **Allow / Decline.**
3. Allowed: written to `project.json` `apps`, usable at once by the live page, the replay and the recording. Declined: the agent goes on without it.

- **Never added without the user.** A desktop app's card shows the exact program to launch (running a local program is a larger permission than opening a page).
- **Once added, allowed for the project** until the user removes it (decided by the user): no asking again each session.
- **Approved at the project, used by scenes** (decided by the user): one approval, every scene may use it.

**Desktop apps.** The same `apps` entry with `kind: electron` (launched and attached over its debugging port: `--remote-debugging-port` + `connectOverCDP`, measured working on a hardened packaged app in Phase 0, F4) or `kind: tauri` (WebKit on macOS: no CDP, partial support, APPROACHES §6b). The format is ready for them; driving them is v0.1 work.

**Existing projects convert** on open: `target` becomes `apps.app` (the rest unchanged).

**Settled with the user (2026-10-05):**
- **Each app has its own URL, and that's all** (no environments: v0 has no staging/prod switching; BACKLOG notes how it would fit).
- **A viewport per app**: each take is recorded at its app's size; the compositor fits every take into the video's one output frame.
- **Removing an app a scene uses**: warned with what it affects (*"Remove docs? 2 scenes use it: Install, First run. They'll need reworking."* Cancel / Remove). Removed, those scenes show **"Uses a removed app"** in the strip (never "unreadable"; their takes stay previewable until re-recorded), and one click asks the agent to rework the scene without it, or the app is added back.

**Implementation notes (design review, 2026-10-05):**
- **Format and migration**: `project` goes to version 2 with a registered `target → apps.app` migration (schema `versioning.ts`). Converted in memory on open, **written at the next save** (never a silent rewrite at open). Every app has its URL (`apps.*.url` required: environments no longer give URLs); a v1 project with an environment and no `target.url` gets a clear error, never a guess. Scenarios aren't touched (no `app:` added: their hash, and so their takes, stay as they are).
- **An app's address is resolved once when it's added** (its redirect followed, the landed origin stored: `minmux.dev` is stored as `https://www.minmux.dev`): a secret is added for the origin its login is really on, and its approval names that exact host (secrets never use the `www.` alias that steps and URL checks do).
- **v0 kinds: `web` and `html`** only; `electron` comes with its driver (`add_app` refuses a desktop kind until then, with that reason). **No two apps on the same site** (`sameApp`): which app a page is on stays unambiguous.
- **`goto`**: `{ action: goto, app?: docs, url: /install }` (`url` defaults to `/`); a relative `url` resolves against the current app. **The first app** is where a scene without `app:` starts: the removal warning counts those scenes too. A **preset** gets an optional `app` (default the first), its relative gotos resolved there.
- **A take has one size**: recorded at **its start app's viewport**; a `goto` to another app keeps that size (the screencast is fixed for the take). The live page takes each app's viewport as the agent moves there, so grounding matches the recording; the replay catches a mismatch.
- **Off the listed apps**: the live page reports it (that's what prompts `add_app`); in the replay and the recording **a step that lands on an unlisted site fails**.
- **The runtime's single base becomes the apps and a current one** (set by `goto { app }`, else the listed app whose site the page is on): URL conditions, a secret's site and the take key use it. The take key uses the start app's URL and viewport.
- **An unknown app** in a scenario is a project-level finding that gives the scene the "Uses a removed app" status, never "unreadable". The secrets panel shows each secret's app; adding one asks which app.

### 0.10 `story.md`: the project's memory (designed 2026-10-05, not built)

One markdown file at the project's root that the agent keeps as the chat goes on: the demo's **audience and goal**, its **outline** (the scenes in order, a line each), **decisions** made with the user, and **open questions**. Named `story.md` ("scenario" keeps meaning one scene's steps: decided by the user).

- **Read at the start of every run** (part of the agent's context, capped): what the agent knows about the demo survives the chat, which lives in memory only today (BACKLOG "Data persistence").
- **Written by the agent with the file tools** (§0.13: `edit_file` for one section, `write_file` for the whole), each change a small "Story updated" row in the chat; the user may edit it too (a plain file in the project, versioned with it). A change the user made since the agent last read it is never written over (§0.13).
- **Lists the attachments** (§0.12) and the pages (§0.11), a line each: what they are, what they're for.
- **Short** (a few thousand characters): a summary the agent keeps current, never a transcript. It doesn't replace the agent runtime's own context handling, nor persisting the chat.

**Scenes stay one folder per scene** (decided by the user): the agent edits one without rewriting others, a broken file breaks one scene only, git diffs stay per scene; `story.md` gives the whole demo at a glance.

**Implementation notes (design review, 2026-10-05):**
- **Given to the agent as part of the run's own message, not the system prompt**: the system prompt sits before the whole history, so a story edit there would break the prompt cache for the whole chat; as a part of the run's message it's read fresh and kept out of the stored history (as an image is today). Capped at 8,000 characters ("truncated" said when a hand edit made it longer).
- **Read at the run's start counts as a read** (its hash noted): the agent can edit it without reading it again; a change the user makes during the run is still never written over.
- **Kiframe never writes `story.md`**: the agent writes the lines about attachments and pages, and each run's context also carries the current list of `inputs/` and `pages/` (nothing missed, no race with the agent's edits).

### 0.11 HTML pages: cut-scenes, slides and mock-ups (designed 2026-10-05, not built)

**A page is an app** (§0.9): `{ "kind": "html", "file": "pages/intro/index.html", "viewport": … }`. Everything a scene does on a web app it does on a page: grounded, replayed, recorded at human pace with the cursor and camera. One mechanism for every scene that isn't the product itself (decided by the user):

- **A cut-scene or slide**: a page with no steps but a pause (`- { id: play, action: pause, ms: 6000 }`): its animation is whatever the page does (CSS, `requestAnimationFrame`, a library it ships with), filmed as it plays.
- **A mock-up**: a page with steps, like any app: the agent clicks the fake "Pay" and types in the fake form. For UI that doesn't exist yet, or that's better not shown for real.

**Where pages live: in the project**, a folder per page (its HTML, CSS, JS, fonts, images), versioned with it:

```
demo.kiframe/
  project.json   story.md
  pages/intro/index.html, style.css, logo.svg
  pages/checkout-mockup/index.html, app.js
  inputs/        the user's attachments (§0.12)
  scenes/<id>/…  as before
```

- **Written mostly by the agent** (decided by the user) from the brief, `story.md` and the attachments, with the file tools (§0.13); the user may edit them too.
- **Templates ship with Kiframe** (in its code, read only): the six former cards (title, section, text, bullets, CTA, outro) and later more (lower third, before/after). Used, a template is **copied into `pages/`** and is the project's from then on (any layout, animation, brand).
- **Served by Kiframe, confined**: each page from a local address serving the project's `pages/` only (no path outside it, no listing). **No network by default** (fonts and libraries are files in the page); a page that needs a host (a CDN font) asks, as `add_app` does, and the host is allowed for that page only. A page never sees a secret, and no secret is ever written into one (§0.13).
- **Filmed in real time** first, by the same recorder. If an animation drops frames, a later renderer steps the page's clock frame by frame (frame-perfect at any export size).
- **Cards are removed** (decided by the user): barely built (the schema and the strip's label; nothing renders them). A project's card scene converts on open to its template's page, filled with its heading, body and bullets.

**Open points:** the page's viewport by default (the video's frame, so a slide fills it); a page's own assets (copied from `inputs/` with `copy_file`, never linked across folders).

**Implementation notes (design review, 2026-10-05):**
- **Each page its own origin, fixed across launches** (never one shared local port): served either through the browser context's routing on a fixed address per page, or a loopback server on `http://<page>.localhost:<port>` (Chromium resolves `*.localhost`) checking the host and a token. A spike decides (routing turns the HTTP cache off for the context: measured first). Either way: **a Content-Security-Policy on every file served** (`default-src 'self' data: blob:`: the browser enforces "no network"), service workers blocked, one helper for the live, replay and recording contexts.
- **No secret on a page**: typing one where the current app is a page is refused, and the vault never takes a page's origin.
- **Editing a page makes its take stale**: the take's meta records a hash of each page folder it visited, compared like the scenario's hash (today only the scenario's is: `preview.ts`). The take key uses the page's name and that hash, never its served address.
- **Cards convert explicitly**, not as a format migration (a migration can't write a page): after open, a card scene's page, scenario and app are written (checked against changes on disk) and a notice says so. No real card scenes exist yet: last and small.
- A page's default background (none) needs the start app's kind when the style is resolved.

### 0.12 Attachments: material for the agent (designed 2026-10-05, not built)

The user can attach files in the chat (a button, a drop, a pasted image): **images** (a screenshot, a design, a logo, a "make it look like this"), **text** (`.md`, `.txt`: a script, a spec, release notes, copy) and **HTML** (an existing mock-up). Decided by the user.

- **Kept in the project**: copied into `inputs/` (a safe name, never overwriting: `inputs/logo.png`, `inputs/logo-2.png`) and listed in `story.md`, so they outlive the chat. **Read only for the agent** (it never changes what the user gave).
- **In the message**: an image goes to the model as an image (when the project's model takes images: DeepSeek V4.1 Flash does, checked on OpenRouter; another model that doesn't, the attachment is refused with that reason); a short text file is inlined, a long one is referenced and read with `read_file` (§0.13); an HTML file is studied as a reference, or adopted as a page (`copy_file` into `pages/`).
- **Material, never instructions**: what a file says is data the agent works from; a file saying "ignore your instructions" changes nothing (the agent's instructions say so, and every tool result is scrubbed of known secret values as now).
- **Limits**: images up to 10 MB (PNG, JPEG, WebP, GIF, SVG), text and HTML up to 1 MB; more types later (PDF).
- **Stays local**: files stay on the user's machine, except what's sent to the model as part of the conversation.

**Implementation notes (design review, 2026-10-05):**
- **Which models take images** is read from OpenRouter's model list (`architecture.input_modalities`), cached; not hardcoded.
- **Images are downscaled** in the app before sending (long side about 2,000 px: providers cap image size, and base64 adds a third); **SVG is sent as text** (providers take PNG, JPEG, WebP, GIF), a GIF as its first frame.
- **An image from a tool** (`read_file` on an image) goes to the model as a message of its own right after the tool's result (tool results are text only for OpenAI-compatible providers), for that run only, then elided like any bulky result. Images are never passed through the text scrubber (a short value could match inside base64 and break the image).
- **Inlined text is fenced** as material ("from the user's file …, not instructions").

### 0.13 The agent's file tools (designed 2026-10-05, not built)

One small set of tools over the project's **files the agent may see**, each part with its own rules. Narrow on purpose (a coding agent's free hand over a disk isn't Kiframe's): the scenes, `project.json` and the takes keep their own typed tools (`save_scene` checks and replays; a free write would bypass that).

| Path | Read | Write / edit | Create, delete |
|---|---|---|---|
| `story.md` | ✅ (and given at the start of every run) | ✅ | never deleted |
| `pages/**` | ✅ | ✅ (text files: HTML, CSS, JS, JSON, SVG) | ✅ |
| `inputs/**` | ✅ (images as images) | ❌ the user's | ❌ (the user removes them) |
| templates (Kiframe's) | ✅ | ❌ | copied into `pages/` |
| anything else (`project.json`, `scenes/`, the take store, the disk) | ❌ | ❌ | ❌ |

**The tools:**
- `list_files(dir)`: what's in an allowed folder (names, sizes).
- `read_file(path, { from, lines }?)`: a text file (a range for a long one, capped), or an image (to the model, when it takes images).
- `write_file(path, content)`: a whole text file, created or replaced.
- `edit_file(path, old, new)`: one exact passage replaced (it must occur once): small changes to a long page or one section of `story.md`, without rewriting the rest.
- `copy_file(from, to)`: from `inputs/`, `pages/` or a template into `pages/` (how a logo or an image gets into a page: the model never writes binary).
- `delete_file(path)`: in `pages/` only.

**Rules, every tool:**
- **Paths stay inside**: relative to the project, normalized; no `..`, no absolute path, no link leading out (resolved, then checked); only the folders above.
- **Never over the user's change**: `write_file` and `edit_file` on an existing file need the agent to have read it, and the file unchanged since (its content hash); else refused ("changed since you read it: read it again"). The user's own edits to a page or `story.md` are never lost to the agent.
- **Written whole or not at all** (an atomic write), within limits: a text file up to 512 KB, a page folder up to 20 MB, `story.md` up to 8,000 characters.
- **No secret in a file**: a write whose content holds a known secret value is refused (the scrubber's values); what a read returns is scrubbed, as every tool result is.
- **Shown in the chat**: each write a tool row with its path ("Wrote pages/intro/index.html", "Story updated"). Undone through the project's history (M1-10).

**Implementation notes (design review, 2026-10-05):**
- **The read-hash list lives with the open project** (the agent host), not the studio (remade when its browser dies), and is cleared when the project closes.
- **Paths**: the parent resolved (`realpath`) then checked inside its folder; compared case-insensitively and Unicode-normalized (macOS: `Pages/`, `STORY.md`); dot-names (`.git`, `.DS_Store`) and links refused.
- **Until history (M1-10), the last versions of each written file are kept** in the app's data (a few per file): an agent's rewrite of a page can be undone.
- **The secret check uses the scrubber's own minimum length** (a short value would refuse innocent HTML).

### 0.14 A scene's background, and a camera on the whole picture (designed 2026-10-05; the format and the camera built, the image next)

**Before** (`packages/compositor/src/draw.ts`, until 2026-10-05) the background was a gradient over the whole frame, the app's window sits at a fixed place inside the padding (rounded, with a shadow), and **a zoom crops and magnifies the take inside that fixed window**: the window and the background never move, as if looking through a fixed hole (the user found it strange).

**A background per scene, or none** (decided by the user):
- `background`: **an image**, or none. Images only for now (no color or gradient).
- `padding`: the space around the app where the background shows; **0 when there's no background** (the app fills the frame).
- **A project default, a scene override.** A new project's default is **an image** (one of Kiframe's, with some padding): polished out of the box. HTML pages (slides, cut-scenes: §0.11) default to none (a slide fills the frame).
- **Images** from the user's attachments (`inputs/`, §0.12) or **Kiframe's own**, shipped in `packages/compositor/backgrounds/` (`backgrounds.json`): autumn road, forest lake, mountain lake (the default), chosen by the user (BACKLOG "Backgrounds").
- **With a background, the app keeps its window look**: rounded corners and a drop shadow, as today. Without one, no window look at all.

**The camera moves over the whole picture**: the stage is the background with the app's window on it, and the camera zooms and pans over that stage. Zooming in on a target (the cursor, a clicked element: aimed as today, from the take's events), the window grows with its corners and shadow and the background slides out past the frame's edges; zoomed out, the app is seen on its background again (as Screen Studio and similar tools do). The view never goes past the background's edges (no empty border). Without a background it's a plain crop of the app.

- **Fixed on screen**: captions (never zoomed).
- **With the content**: blurs over secrets, the cursor, click ripples.
- **Zoom cap** as today (§2b): beyond the capture's resolution the image softens.

**Implementation notes (design review, 2026-10-05):**
- **Format** (built 2026-10-05: a shipped image or none; the image covers the picture, cropped to its aspect, never stretched; the preview loads it from the app's bundle, the exporter from the compositor's `backgrounds/`; a host that passes no image gets the former gradient): the style's `background` becomes `{ builtin: id }` or `"none"` (`{ file: "inputs/…" }` once attachments exist), padding 0 with none; the scene's override stays `composition.style`, the default `project.style`.
- **Camera segments keep app coordinates** (built 2026-10-05: `stageTransform`, `keepInPicture` in `packages/compositor/src/scene.ts`): `scale` stays "magnification of the app's window", so generators don't change; only the view and the drawing map the app onto the stage and clamp to the stage. The zoom cap's softness formula stays right. A segment's `scale` counts from the app filling the frame (`appFill`, 2026-10-06): on the picture, it's magnified by as much more as the window is smaller than the frame, so a target is framed as the generators mean it, with a background or without one; rest (no segment) stays the whole picture. The zoom cap (`maxScale`) is on the app's magnification too: the same softness either way.
- **Drawing under a zoom**: the window's shadow, the blur radius and the cursor size are corrected for the scale (canvas shadows ignore the transform; the cursor grows less than the zoom, as today); captions drawn without it.
- **No background, another aspect** (a 16:10 app in a 16:9 video): black bars, the view clamped to the app.
- **Loading**: the preview imports the shipped images as app assets (its CSP allows only its own files), an attachment comes as bytes; the exporter gets the background's path in its job and serves it.

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
version: 1
environment: staging             # org-level environment (APPROACHES §10c): URL, sandbox flag, pre-approvals
target:                          # to become named `apps` (§0.9, designed)
  kind: web                      # web (v0) | electron (v0.1) | tauri (later)
  url: https://staging.acme.com  # Phase 0: set here. Later: comes from the environment
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
      - id: email                                        # a step typing a secret needs an id: its approval refers to it (SECRETS-DESIGN §3)
        action: type
        target: { by: label, name: "Email" }
        value: "{{secrets.acme_staging.email}}"          # vault NAME only (APPROACHES §7.4)
        instant: true                                    # off camera: no human typing needed
      - id: password
        action: type
        target: { by: label, name: "Password" }
        value: "{{secrets.acme_staging.password}}"
        instant: true
      - action: click
        target: { by: role, role: button, name: "Sign in" }
interrupts: []                   # §2b
hide: []                         # §2b
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
  - id: remove-old                             # a look-alike (each row has one): told apart by its row,
    action: click                              # the list item holding exactly "Q3 Launch" (never `nth`:
    target:                                    # a reordered list turns a position into another row)
      { by: role, role: button, name: "Delete", in: { role: listitem, has: "Q3 Launch" } }
    risky: true
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
| `goto` | `url` | **Relative** to the environment's URL (absolute and `//host` URLs are rejected, so a scene never leaves the target app) |
| `click` | `target`, `button?`, `count?` (2 = double-click), `modifiers?` | Also covers checkboxes, custom menus and dropdowns |
| `hover` | `target`, `hold?` | Shows tooltips and menus |
| `type` | `target`, `value`, `clear?`, `submit?` (Enter at the end), `instant?` (off camera) | Human typing by default. `value` can be `{{secrets.x}}` |
| `press` | `keys` (`"Mod+K"`, `"Enter"`) | `Mod` = ⌘ on Mac and Ctrl elsewhere. Can show a keystroke overlay |
| `select` | `target`, `option` | Native `<select>` only (custom dropdowns = `click`s) |
| `scroll` | `to: target` \| `by: {y}` \| `until: target`, `within?: target` | Long pages and lists. **Smooth synthetic scroll** (eased) |
| `drag` | `target`, `to: target \| {dx,dy}` | Kanban, sliders, reordering |
| `selectText` | `target`, `text` | **A real selection with the pointer**: pressed before the passage's first character, dragged to after its last, then checked against what the browser selected. To point at a sentence, or act on it next (an editor's Bold). The text as shown (case, dashes, quotes, spaces don't matter), once in the target, over links and bold; matched in Node on the target's rendered text, never a form field's value |
| `upload` | `target`, `file` (project asset) | The OS dialog isn't filmed. We show the result |
| `waitFor` | `until: { visible \| hidden \| text \| url \| networkIdle }`, `timeout?` | Synchronization, never a fixed sleep |
| `pause` | `ms` | **A presentation beat**: let the viewer look. Never sped up |
| `expect` | same conditions as `waitFor` | **Off-camera check** of the state. Used by grounding and **health checks** (drift → `stale`) |

Setup/teardown-only directives: `preset`, `ensure` (§2).

A `risky: true` flag goes on any step that deletes, sends, pays or invites. It needs confirmation unless pre-approved on a sandbox environment (APPROACHES §7.2–7.3). The agent sets it, and the runtime also detects obvious cases (Delete/Remove/Send/Pay/Invite…) **at the press point, at press time** (after hover): it reads everything the control under the cursor is called (its text, hidden text included, and every aria-label / labelledby / title / alt / submit value inside it). This detection is a safety net that **fails closed**: if any of it mentions such a word, the click needs approval; `risky: false` on the step opts out. Clicking a card's title isn't judged by a Delete button elsewhere in the card, but a press that would land on that button is.

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
  - id: cookie-banner            # required: interrupt events in the take refer to it
    when: { by: role, role: dialog, name: "Cookie preferences" }
    do: { action: click, target: { by: role, role: button, name: "Accept all" } }
  - id: whats-new
    when: { by: role, role: dialog, name: "What's new" }   # the dialog, not a text also in a menu
    do: { action: press, keys: "Escape" }
hide:                            # removed from the frame with injected CSS (display: none)
  - "#intercom-container"
  - ".nps-survey"
```
- **Mechanism (revised):** *not* Playwright's `page.addLocatorHandler()`. That handler fires inside actionability checks, which can be between a `mouse.move()` and a `mouse.down()`, and Playwright warns that the mouse is then left in the wrong position. That's exactly our human-cursor pattern. Instead, **the runtime runs an explicit interrupt check before each step's cursor travel**. If an interrupt matches, it runs its `do`, marks the time span, and **re-plans the cursor path**. The screencast keeps running, and the marked span becomes a **cut** in the `clips` track, so it's invisible in the video.
- Interrupts that appear **mid-step** (rare) are handled inside a click when its target is found covered, before the press. Steps are never retried (a retry could repeat an action that already happened).
- A rule runs **at most once per page** in a run (a dismissed banner may stay in the page, faded out). After its `do`, a fading dialog is waited for briefly, inside the cut. A rule's own actions never trigger another interrupt check, and a `do` marked `risky: true` asks for approval like a step.
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
<app-data>/Kiframe/takes/<projectId>/<sceneId>/take-<time>-<id>/   (looked up by meta.takeKey)
  frames.webm          raw video at DPR 2, WITHOUT a cursor (the cursor is drawn at render time). NOT blurred → sensitive, encrypted at rest
  events.jsonl         timestamped semantic events
  cursor.jsonl         cursor samples (real mouse positions, so hover states happened in the app)
  shots/<stepId>.jpg   frame at each step_start (storyboard + guide screenshots)
  meta.json            viewport, DPR, fps, scenario hash, environment, app URL, recordedAt, Kiframe version
  (pinned or scratch is derived from the compositions, exports and versions that name it: never stored in the take)
```

```ts
// Coordinates are normalized to the viewport (0..1 = on screen), so they're resolution independent.
// Observed element rects are NOT clipped: an element can be partly off screen or zero-size, and a
// half-hidden secret field must still be masked. The renderer clips to the frame.
type ViewportRect = { x: number; y: number; w: number; h: number };  // w, h >= 0, any x/y
type NPoint = { x: number; y: number };                              // 0..1 (the pointer is on screen)

// t = ms from the first frame (screencast timestamps). `phase` = which part of the scenario produced
// the event; on-camera events (`steps`) carry a stepId, off-camera work (setup, presets) may not.
type TakeEvent = { t: number; phase: "setup" | "steps" | "teardown"; stepId?: string } & (
  | { kind: "step_start" | "step_end" }
  | { kind: "click"; point: NPoint; rect: ViewportRect; button: "left" | "right" }
  | { kind: "type_start" | "type_end"; rect: ViewportRect; secret?: string }  // secret NAME only
  | { kind: "key"; key: string }                                       // for keystroke overlays
  | { kind: "scroll"; delta: { x: number; y: number } }                // normalized, unbounded
  | { kind: "navigate"; url: string }                                  // origin + path only (no query/hash), scrubbed
  | { kind: "settled" }                                                // network idle + DOM stable
  | { kind: "frame_target"; ref: string; rect: ViewportRect }                 // rects for `camera.frame` / `emphasis` locators
  | { kind: "sensitive"; id: string; why: "secret-field" | "secret-text"; until: number;  // t = from
      boxes: { from: number; until: number; rect: ViewportRect }[] }  // one event per region, whole span (SECRETS-DESIGN §5)
  | { kind: "interrupt"; rule: string; until: number }                 // span to cut (§2b); rule = InterruptRule.id
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
    masks:      MaskSegment[];     // blur/pixelate or highlight/spotlight (secret regions aren't here: drawn from the take)
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
  | { scene: "start"; offsetMs?: number }           // card / still / media scenes: offset >= 0 from the start…
  | { scene: "end"; offsetMs?: number }             // …or <= 0 from the end (anchors stay inside the scene)
  | { ms: number };                                 // escape hatch: absolute source time

type ClipSegment = SegmentBase & (
  | { mode: "speed"; speed: number }   // 1 = real time. Idle gaps and network waits → e.g. 4
  | { mode: "cut" }                    // removed from the output (setup, interrupts, very long waits)
) & { reason?: "idle" | "network" | "setup" | "interrupt" | "reading" | "user" }
  // A freeze has no `until`: it holds the source frame at `at` for `ms` of output time.
  | { id: string; source: "auto" | "manual"; at: Anchor; mode: "freeze"; ms: number; reason?: "reading" | "user" };

type CameraSegment = SegmentBase & {
  scale: number;                               // 1 = the app filling the frame, 2 = 2x that (capped, §2b, §0.14)
  focus: { mode: "follow-cursor" } | { mode: "rect"; rect: NRect } | { mode: "point"; p: NPoint };
  ease?: "spring" | "instant";
};

type CaptionSegment = SegmentBase & { text: string; position?: "bottom" | "top" | "near-target" };

type MaskSegment = SegmentBase & {
  kind: "blur" | "pixelate" | "highlight" | "spotlight";
  target: { sensitiveId: string } | { frameRef: string } | { rect: NRect };  // only adds: a blur naming a secret region extends it (the take draws the region anyway)
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
- **masks:** one highlight/spotlight per `emphasis`. Secret regions (`sensitive` events) are never masks: the compositor draws them straight from the take, each box over its own span, so no composition edit removes or shortens them (SECRETS-DESIGN I4).
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

**Recommendation:** our own compositor, with **the export done in the frontend** (Electron's Chromium). **Implemented with Canvas 2D** (P0-7, PHASE0-FINDINGS F3): enough for one video layer, a camera and overlays; PixiJS if the live preview needs more.

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
