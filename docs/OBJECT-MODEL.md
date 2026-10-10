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
- Each scene has its own **off-camera `setup`**: navigate there, and get the app ready (a preset logs in, a goto opens the page). Common setup is shared as **presets**.
- **Login is not repeated per scene.** A preset marked `session: true` (for example `login-as-manager`) runs **once per recording batch**. Its `storageState` is then reused for every scene of the batch (APPROACHES §7.2).
- **Nothing is cleaned up after a scene** (decided by the user, 2026-10-07): what a demo creates or changes stays in the app, and the window says so under the preview once a scene has played to its end. Kiframe can't see how an app stores its data (black box), so a cleanup would be a second, fragile scene of deletes: the `teardown` and `ensure` that did it are removed. Scenes written before keep them in their file (they still read, their hash and takes unchanged), skipped with a warning when they run; a new scene can't have them. A scene that creates something is best written so it also works when run again (a name that can exist twice), or recorded on an account the user resets.
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

**Implemented (M1-1, `packages/schema`):** `Project` (`project.json`), `Scene` (`scene.json`), `OrgSettings` (brand kit, style, environments, rule bank, LLM policy), `UserPreferences`, `Style` / `StyleOverride`, and `resolveProjectConfig` (org + project → the `ProjectConfig` the runtime reads: the project's apps, org rules before the project's; no environment since project v2, §0.9). Differences from the sketch above: a scene's scenario and composition are separate files (`scene.json` holds `source: { kind: "recording" }`), a guide output lists its `formats`, v0 has only the `recording` / `card` kinds and `video` / `guide` outputs, and every document has a `version` with migrations on read (a newer version is refused).

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

**The take key:** `takeKey = hash(scenario + start app's URL and viewport + capture settings) + recordedAt`.
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

1. **Explore and ground, on the live page.** The agent reads the page with `snapshot` (roles, labels, text, each element's ref) and tries actions with `run_step` / `run_steps`: each really runs on the page and says whether it worked and where the page ended. Nothing is written yet: every step is proven on the real app first ("ground every step"). What the steps create stays in the app (no cleanup, §0.4).
2. **Write the scene.** `save_scene` takes the whole `scenario.yaml` (setup, on-camera steps), checks it, and **replays it from scratch in a fresh browser** (no cookies, no storage). Saved only if the replay passes; otherwise the failure comes back and the agent fixes the YAML.
3. **Record.** `record_scene` films the saved scenario at human pace in another fresh browser; the composition (camera, cursor, captions) is generated from the take.

**The live page isn't fresh.** It's one browser session for as long as the project is open, shared by every scene: it keeps what the agent did (signed in, scrolled, a setting changed). The replay in phase 2 is what catches a scene that only works because of that state. Refs never reach the YAML (a ref becomes a locator that finds that element alone).

### 0.9 Apps a demo shows (designed 2026-10-05; built 2026-10-06/07, B1–B5)

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

**Electron apps (designed 2026-10-08, design reviewed; moved into v0).** `{ kind: "electron", bundleId, args?, origins?, viewport }`:
- **Named by bundle id, never a path or a program** (a project may come from someone else): the desktop app finds the bundle on each machine and keeps the user's approval in its own settings (bundle id, real path, signing team); only `.app` bundles holding `Electron Framework.framework`; App Store (sandboxed) apps refused. `args` are positional only (no switches). `origins`: the https sites a wrapper app (Slack, Notion) shows as its own.
- **No address**: a goto or a URL condition on it is refused; a scene starting in it opens on its first window; it takes no secrets in v0 (the user signs in by hand: the handover).
- **Each run launches it sandboxed** (its own HOME, `CFFIXED_USER_HOME`, XDG and temp folders, `--user-data-dir`; an allowlisted environment, never Kiframe's), attached with `--remote-debugging-port=0` + `connectOverCDP`; the viewport is emulated (a spike measured frames and clicks with the window covered, off-screen, minimized or hidden: a run never needs the user's screen; the window itself can't be moved over CDP). Isolation is enforced, never checked after the fact: every launch is confined (below). Its process group killed after each run, leftovers swept.
- **Confinement: a guard, sealed at launch (PR 2, redesigned after three review rounds, design reviewed).** Once the app settles (its windows unchanged 1.5 s), its main window is the last opened still open; its own scheme or dev server is learned from that window alone, then sealed (nothing a run does adds to it). A main window that isn't the app's own (a wrapper's unlisted site) refuses the launch ("list it in its origins"). From then a **guard** checks every navigation of every frame of every window as it happens: a page that isn't the app's own is stopped at once (a popup closed, any other frame blanked: never left for a read or a frame) and recorded; the step fails `off-app`. The app's own: a local `file:` in its bundle or sandbox (decoded, normalized), its sealed scheme or dev server, a listed https site (`sameApp`, never plain http), a blob of those. Stated (as a web run): the guard acts as a page commits, so a page that isn't the app's own has loaded (its scripts ran, with the app's own rights) before it's stopped: following a link the app offers is what its user does too (blocking before the load needs request interception, which never sees `file:`); and the runner's own navigation events name it as they do for web runs (origin and path, known secret values scrubbed). What the main window embeds as it opens (a frame of another site) is the app as shipped: its origin is the app's own. A main window stopped goes back to the app's page (no goto there to bring it back); a failed load is said as one. **One app per run:** a desktop app's run never shows a site (no goto, URL condition or web preset; a web interrupt rule's goto skipped, said), is confined while grounding too, and keeps no sign-in between runs yet.
- **Windows (PR 2, known limits, to settle on real apps in PR 3 and PR 5: decided by the user 2026-10-08):** the main window is the last opened still open once the app's windows were unchanged for 1.5 s (a splash that stays up longer is taken for the main window); windows the app's main process opens are followed as popups are (a hidden helper window opened during a step may be followed: CDP can't tell it's hidden); only the launch window is sent back when it goes off-app (another window is closed); a stop that lands after its step ended counts against the next step. A window that opens blank gets a moment to load (as a web page does); a frame of a window the run isn't driving is said, never the step's failure.
- **Every launch confined (PR 3a, 2026-10-09, design reviewed twice, measured):** on macOS each launch runs under Seatbelt (`sandbox-exec`, `electron-confine.ts`): writes only into its own sandbox; no reads of /Users, /Volumes, the temp folders, the user's home and the work area wherever they are (a home outside /Users) but its sandbox and its bundle; nothing run from its sandbox (the one place it writes: a program it drops there, a copied launcher), no `open`, `osascript`, `launchctl` nor Apple Events; no unix sockets (an agent's: ssh, Docker) but mDNSResponder; no preferences (cfprefsd), keychain (SecurityServer: a mock keychain instead, `--use-mock-keychain`) nor clipboard (the user's may hold a password just copied: an app's own copy and paste doesn't work in a run); the network on, for runs and trials alike (the app's backend, a wrapper's site: an updater can't touch the real app, nothing outside the sandbox being written; what an app could send is only what it can read here: its bundle, the system's files, its own sandbox). Chromium's own sandbox can't nest in it (`--no-sandbox`): the guard and this profile replace it. A canary before every launch, before the files are copied (a read the profile refuses must fail, one of its sandbox succeed: a confinement that runs nothing never passes); no `sandbox-exec`, or a canary failed: no launch (never unconfined). Off macOS: desktop apps don't launch (CI's tests only, unconfined). Measured with a probe app: every escape above `EPERM` (a hard link or a symlink to an outside file too), the app driven as usual. This replaces the trial's after-the-fact isolation check, rejected by review (an app that leaks does its harm as it starts). **What it doesn't stop (stated):** an app can still ask macOS to open a file or a URL (LaunchServices: no app starts without reaching it, measured), and what opens runs outside the confinement; it reaches services on this machine (localhost: a dev build's own server needs it). The app's own pages are its bundle and what it writes in its sandbox's home, profile and temp folders (a page it builds there from remote content counts as its own, as its cache already does); never the files/ copy. The confinement keeps an app from the user's data by accident (the minmux incident), not an app built to escape (one the user runs unconfined every day anyway).
- **Adding a desktop app (PR 3b, design reviewed 2026-10-09):** inspected first, statically (`electron-inspect.ts`: only `plutil` and `codesign` run): refused outside where an app can stay (a disk image, a temporary translocated copy, the Trash, inside another app), not Electron (its framework; no version gate: Figma reports 13.6.1), an executable that isn't its own file, a Mac App Store build (App Sandbox), a developer signature that doesn't hold (`codesign --verify --strict` against its team and signed identifier). Kept: its id, name, Electron's version, and its signer: a developer (team id) or, ad hoc and unsigned (the user's own builds), pinned to a digest of the whole bundle (a link leading outside it refused; at most 4 GB and 200,000 entries). Then **tried confined** (`electron-trial.ts`): launched with the network as in a run (an updater can't touch the real app: nothing outside the sandbox is written; a wrapper's offline page can't hide its site), its main window attached, closed; a wrapper's site is named (even unreached: the error page's unreachable URL, over CDP) and allowed by the user in a second trial. A main window that never loaded its own page (offline, a dev server not running) is refused at launch, said as such: never a window driven on Chromium's error page. An attach that hangs as the first page fails (measured 1 in 5; cause not found) is tried again within the launch's time (stated). A trial runs only the build that was picked (its developer's signature, or its pinned digest, checked first; a change between that check and the launch is the user's own build tool's: holding every launch to its approval is PR 4's, with runs). codesign that fails or times out refuses the app (never read as unsigned or unsandboxed). Apps that allow one copy (Slack, VS Code, Discord) need Chromium's temp folder in the sandbox (`MAC_CHROMIUM_TMPDIR`): its lock's socket otherwise goes to the user's /var/folders, denied, and the app quits.
- **Approvals (PR 3b-2, user decisions 2026-10-09):** added from the Apps panel ("Add desktop app…", macOS): main shows the picker (Applications) and inspects what was picked; the window gets a card and a token, never the app's path, and never names a site to allow (the trial's, kept in main). Tried confined, then added (the build that was tried is approved: one updated since says "updated"; `project.json`, its changed-on-disk refusal) and approved in app data (`desktop-apps.json`, 0600, written whole; one that doesn't read is set aside and said, never overwritten). An approval is per copy of the app on this Mac (where it was picked: a release and a dev build of one bundle id kept apart, a project using one of them; at most 20 copies of one app kept, the oldest let go) and per project folder (the registry's scope) and covers the app (its developer's team, or the exact build of an unsigned one) **and what the project opens with it** (its `args` and `origins`, as a digest): a pull that changes either asks again. Statuses (static, opening the panel launches nothing): ready; updated (same developer, a build this project hasn't tried: tried confined before its next run, PR 4, which records it); allow (approved for another project, or never on this Mac: pick it to allow it here, without adding it twice); opens-changed; changed (another developer, another unsigned build); not found. Removing the app drops this project's approval. Off macOS: nothing offered. A trial in progress ends with its add (another pick, the project closed, a quit); what a crash left is swept at the start.
- **Launching an approved app (PR 4, design reviewed 2026-10-10):** main launches a project's desktop app only from its approval for this project folder and what it opens (`desktop-launch.ts`): the copy approved, inspected once (its status); `ready` launches it (the copy's executable and bundle; the project's `files/` when it has one, its `args`, `origins`, viewport); `updated` (the same developer's new build) is tried confined first, quietly (one trial per app and project at a time), then that build approved for the project compare-and-set (the same copy, developer and opens, the project still the open one: else refused); anything else is refused for the user to settle in the Apps panel (`needsUser`: the agent says so, never retries). A take of a desktop app keeps its build (`appBuild`: its version and what it opened; never in the take's key, never a reason to record again: user decision 2026-10-10; an older Kiframe can't read such a take: its meta is strict). Kif starting ends an add's check in progress.
- **Kif in a desktop app (PR 4b, design reviewed 2026-10-10):** the studio grounds, checks and records a scene in a desktop app as in a web app, through the host's launcher (`launchDesktop`: from the approval, confined). Grounding keeps one live launch of the scene's app (one desktop app live at a time: another app's scene closes it first, a web app's live context stays between web apps; an app that quits while grounded is launched again and said: "what earlier steps did is gone"). A desktop launch is owned by the tool call that started it (redesigned after three review rounds): its stop or the studio's close ends it (its quiet trial, its spawn: nothing comes live after a stop), it's never joined (a call while it goes on is refused; one after a stop waits it out); an app removed or changed while it opened is never kept; a check or recording of a desktop scene closes that app's live copy first (one copy at a time: an app may allow only one; said with the next step; another app's live launch stays); a step's shape is checked before any app opens or closes for it. With several apps and none open, snapshot, look and a handover never guess which to open: the agent opens the scene's app with a step first (one app: it opens); a check and a recording each run in a fresh launch (its own sandbox: the same files and state every time), closed whole after. Its pages, and a snapshot's link addresses, are said by its guard (its own page or not, `placeOf`): never its file path. A launch's errors name no local path by construction (the runtime's say "the app isn't where it was approved any more", an OS error by its code); the launcher passes only those and its own refusals, anything else by its code, and replaces whole a message naming a folder it knows. Every launch failure is the user's to settle (`needsUser`: the agent tells them, never retries; an approval's refusal names the Apps panel). No handover in a desktop app yet (decided 2026-10-10: measured in PR 5): a scene with one isn't saved, a run's request for one is declined. A take keeps the app's build (`appBuild`). Every launch's quiet trial ends as the project switches or the app quits.
- **The work area `~/.kiframe/`** (decided by the user 2026-10-09: deletable any time): `sandboxes/` (one per launch, 0700, never a link), each named after the Kiframe that made it (`kiframe-app-<pid>-<start>-…`: owned from the moment it exists, no shared state file to race on); a crash sweep at start removes only sandboxes no running Kiframe owns (the processes pointing at them killed first), never another build's launch, and nothing when `ps` can't be read. Kept out of Time Machine and Spotlight. Approvals stay in the app's settings, takes in app data.
- **A project's `files/`** (decided by the user 2026-10-09): what a desktop app opens. Copied into the sandbox at each launch by Kiframe's own walk (folders and regular files only: a link, a FIFO, a device refused; 500 MB, 20,000 files, depth 32; cloned where the disk can, times kept); `args` name paths in it only (`files/vault`, given as the copy's path); the app's edits stay in the copy (thrown away: every run from the same files). The copy is the project's content, never the app's own pages for the guard. Filled by the user in v0: the agent's file tools never reach `files/` (it may hold what runs inside the app: an editor's tasks, a vault's plugins).
- **Measured on a fixture app (PR 2, 2026-10-08):** HOME, XDG and `--user-data-dir` hold; macOS's own places don't move: Electron's `appData` (`~/Library/Application Support`) and the app's preferences (`NSUserDefaults`, written by `cfprefsd` into the user's real `~/Library/Preferences/<bundle id>.plist`) stay the user's whatever `HOME` or `CFFIXED_USER_HOME` say. Hence the confinement (PR 3a, below): the preferences daemon is denied and writes outside the sandbox refused, so neither can be reached (a check after launch, the earlier plan, came too late).
- **Stated limits:** native dialogs and menus are unreachable; links open in the user's real browser; a sign-in through the browser with an app-scheme callback isn't supported in v0; the keychain and an app's macOS preferences are the user's (an app reading its own keychain item signs in as them); a window built from several views films one view.
- **Built in steps** (epic `epic/electron-targets`): the format (2026-10-08), the launcher and target, the desktop approval and trial, the studio and batch on it, a real pass on a sandboxed minmux.

**Existing projects convert** on open: `target` becomes `apps.app` (the rest unchanged).

**Settled with the user (2026-10-05):**
- **Each app has its own URL, and that's all** (no environments: v0 has no staging/prod switching; BACKLOG notes how it would fit).
- **A viewport per app**: each take is recorded at its app's size; the compositor fits every take into the video's one output frame.
- **Removing an app a scene uses**: warned with what it affects (*"Remove docs? 2 scenes use it: Install, First run. They'll need reworking."* Cancel / Remove). Removed, those scenes show **"Uses a removed app"** in the strip (never "unreadable"; their takes stay previewable until re-recorded), and one click asks the agent to rework the scene without it, or the app is added back.

**Built (B1, 2026-10-06):** the format and its migration; behaviour as before (every scene in the first app, steps and secrets on its site).
- `Project` and `ProjectConfig` are version 2: `apps` (1–20, named `^[a-z][a-z0-9_-]{0,39}$`, never two on one site), no `target` and **no `environment`** (an environment's sandbox flags would otherwise pre-approve risky teardowns on whatever URL the apps name). `firstApp`, `appOf` (own keys only); an app's `viewport` defaults to 1440×900 @2x.
- A v1 project converts on read (`target` → `apps.app`; with an environment, refused with what to do); the file is rewritten at the next save, a scene the agent saves included.
- A take's meta names its start app (`app`); the take key hashes the start app's URL and viewport (as the target's before).
- A new project's address is resolved when it's created (desktop main, `resolveAppAddress`), only when it's a bare site (`minmux.dev`: a typed path was never checked on another origin, and the app may live there on this one; a one-time link is never fetched): its root fetched with Node's fetch (no browser session), redirects followed one by one (≤ 5, http(s) only, 5 s, run while the save dialog is open); adopted (its origin's root) only when it lands on the same app and answers (2xx) (`www.` or https), never a login host or another site; offline or slow: kept as typed.

**Built (B2, 2026-10-06):** scenes move between the listed apps (the agent is told in B3).
- A scenario's `app` (where it starts), `goto { app, url }`, a URL condition's `app`, a preset's `app`: all optional, by name; a scene naming no app keeps its hash (and its takes). An app the scene or its presets name but the project doesn't list: refused before anything runs (`unknownApps`; an interrupt rule's goto to one fails where it runs: an org's rules apply to every project).
- **Which app a step means** is read from its own text, never from where the page went or what ran before it (a reviewed redesign: following the page, then carrying the app from step to step, made a teardown delete on whichever app the scene stopped in, and a step grounded alone mean another app than in the replay): the app it names (`goto { app }`, a URL condition's `app`), else its scene's start app (its `app`, else the first), its preset's inside a preset (else the first), the first app for an interrupt rule. Links, redirects and popups never change it. So every step on another app names it (the agent is told so in B3).
- **Secrets**: the runtime types one only on a listed app's exact origin (never a `www.` alias, never an unlisted site such as an SSO host); which app's secret goes where is the resolver's to refuse (`resolveSecret`'s contract): the vault checks the secret's own origin, so a secret added for `app` is never typed on `docs`; the scripts' `.env` resolver is bound to one origin. The agent's secret names and the Secrets panel stay the first app's (B3).
- A take is filmed at its **start app's** viewport (batch, studio replay and record); its meta names that app. A saved session's landing is kept with its app (`{ app, url }`) and replayed there.
- `whereOf` names the app (`docs: /install`) when the project has several; a page off them is "NOT one of the project's apps".
- Not yet (stated): a step landing on an unlisted site doesn't fail (B4, when the agent can add the app); the live page stays at the first app's size (B3: the scene's start app known to the studio).

**Built (B3, 2026-10-07):** the agent and the user see the apps.
- **The agent**: its prompt lists the apps (one app: as before) and the rule: a scene starts in the first app unless it says `app:` at the top level; a step without an app means the scene's start app, never the app the page went to; every goto and URL condition on another app names it. It writes `app:` itself (decided: explicit, what the runtime reads; the studio never infers it from where the page went). `run_step` / `run_steps` take the scene's `start_app` (else the one its last step ran in, else its saved `app:`, else the first; kept only once a step ran, and set by `save_scene`), so a step grounded alone means what it means in the replay; `save_scene` notes a scene saved with another start app than it was grounded in. `whereOf` always names the app when there are several. `list_secrets` gives each name with its app (the studio's own apps, asked at the moment).
- **The user**: the Secrets panel lists secrets app by app and adds one for the app picked. The window names an app, never an origin: main finds the app's exact origin in the project (`appOriginOf`), refusing a request from an earlier opening of a project (`session`). `ProjectView.apps` carries each app's origin from main.
- The vault never grants a secret on an origin it isn't for.
- Not yet (stated, BACKLOG): the live page keeps the first app's size (resizing it would leave refs and popups at the old size, and rebuilding its context per app would sign it out); the replay, at the filmed size, catches a difference.

**Built (B4, 2026-10-07):** the agent adds a site with the user's approval; a step off the apps fails.
- **`add_app({ name, url, why })`** (web only): the address resolved as a first app's; refused without asking (the cheap checks before any fetch) when 3 cards were already shown this session, the name is taken, the address isn't http(s) or carries credentials, the user declined that site this session (in any form: its www., a path), the site is already an app (`sameApp`, a trailing dot ignored), or project.json changed on disk; the whole project checked before asking. A new app gets the first app's viewport (the size grounding uses). **The card** is built from what would be written: the host as the browser reaches it (punycode, port), "not encrypted" on http, a lookalike warning on a punycode label, "on your computer or local network", "every page on this site", "scenes may open it; no secret is shared with it"; then the agent's reason, cleaned to one plain line and said as its words (pages it read can influence it). Allowed: written to project.json, the studio's apps updated at once, the window refreshed; the tool tells the agent how to use it (its instructions are fixed for the run). A save that fails (project.json changed on disk) is said.
- **A step that ends off the project's apps fails** (`off-app`), on by default: replays, recordings, batches; off for a step grounded on the live page (it says where it went: the moment to add the site). An allow-list: a listed app's site, a blank page (a tab a step opened is checked once its first page loaded), a listed app's blob:; Chromium's error page fails as "the page failed to load"; anything else (another site, file:, data:) fails, after up to 2.5 s for a redirect still coming back.
- An unknown request kind shows "unsupported" with Decline only (never the question form).
- Not yet (BACKLOG): the registrable domain bolded on the card, apps the agent added marked in the panel. (Removing an app: B5, below.)

**Built (B5, 2026-10-07):** removing an app; the scenes that use it marked.
- **The Apps panel** (the title bar's app chip): each app with its exact origin; every app but the first can be removed (the first is where scenes without `app:` start: removing it would move them silently; changing it: BACKLOG). Refused while the agent works (an add_app card may be open), for a request from an earlier opening, or when the app by that name isn't the one the window showed (its origin); checked again after the confirmation.
- **The confirmation** (main's dialog) names the scenes that use it (`appsNamedBy`: start app, gotos, URL conditions, presets they use; every stored scene) the presets that name it, and the interrupt rules that go there: "2 scenes use it: “Install”, “First run”. They'll need reworking (their recordings still play)."
- **Removed**: this project's approvals on that site revoked first (a failure then removes nothing), saved to project.json (the secrets stay in the vault: other projects may use them; added back, the add_app card says how many saved secrets come with it, and which scenes already name the app: they'll open the site added), the studio told first (`setApps`: a scene's start app no longer listed dropped, a saved `app:` no longer listed skipped, the last snapshot's refs dropped), the window refreshed; a revoke that fails is said.
- **A scene using an app the project doesn't list** keeps its status (recorded, grounded: its recording still plays) and shows "Uses an app not in the project: docs" in the strip under its status, with "Rework without it" (asks the agent; disabled while it works). The runtime refuses running it and save_scene refuses saving it until reworked.

**Implementation notes (design review, 2026-10-05):**
- **Format and migration**: `project` goes to version 2 with a registered `target → apps.app` migration (schema `versioning.ts`). Converted in memory on open, **written at the next save** (never a silent rewrite at open). Every app has its URL (`apps.*.url` required: environments no longer give URLs); a v1 project with an environment and no `target.url` gets a clear error, never a guess. Scenarios aren't touched (no `app:` added: their hash, and so their takes, stay as they are).
- **An app's address is resolved once when it's added** (its redirect followed, the landed origin stored: `minmux.dev` is stored as `https://www.minmux.dev/`): a secret is added for the origin its login is really on, and its approval names that exact host (secrets never use the `www.` alias that steps and URL checks do).
- **v0 kinds: `web` and `html`** only; `electron` comes with its driver (`add_app` refuses a desktop kind until then, with that reason). **No two apps on the same site** (`sameApp`): which app a page is on stays unambiguous.
- **`goto`**: `{ action: goto, app?: docs, url: /install }` (`url` required, as built); a relative `url` resolves against the app it names, else the scene's start app (as built in B2: never the app the page went to). **The first app** is where a scene without `app:` starts: the removal warning counts those scenes too. A **preset** gets an optional `app` (default the first), its relative gotos resolved there.
- **A take has one size**: recorded at **its start app's viewport**; a `goto` to another app keeps that size (the screencast is fixed for the take). The live page takes each app's viewport as the agent moves there, so grounding matches the recording; the replay catches a mismatch.
- **Off the listed apps**: the live page reports it (that's what prompts `add_app`); in the replay and the recording **a step that lands on an unlisted site fails**.
- **The runtime's single base becomes the apps** (as built in B2: each step means the app it names, else its scene's start app; the design's "current app followed from the page" was replaced after review): URL conditions, a secret's site and the take key use them. The take key uses the start app's URL and viewport.
- **An unknown app** in a scenario is a project-level finding that gives the scene the "Uses a removed app" status, never "unreadable". The secrets panel shows each secret's app; adding one asks which app.

### 0.10 `story.md`: the project's memory (designed 2026-10-05, built 2026-10-07)

One markdown file at the project's root that the agent keeps as the chat goes on: the demo's **audience and goal**, its **outline** (the scenes in order, a line each), **decisions** made with the user, and **open questions**. Named `story.md` ("scenario" keeps meaning one scene's steps: decided by the user).

- **Read at the start of every run** (part of the agent's context, capped): what the agent knows about the demo survives the chat, which lives in memory only today (BACKLOG "Data persistence").
- **Written by the agent with the file tools** (§0.13: `edit_file` for one section, `write_file` for the whole), each change a small "Story updated" row in the chat; the user may edit it too (a plain file in the project, versioned with it). A change the user made since the agent last read it is never written over (§0.13).
- **Lists the attachments** (§0.12) and the pages (§0.11), a line each: what they are, what they're for.
- **Short** (a few thousand characters): a summary the agent keeps current, never a transcript. It doesn't replace the agent runtime's own context handling, nor persisting the chat.

**Scenes stay one folder per scene** (decided by the user): the agent edits one without rewriting others, a broken file breaks one scene only, git diffs stay per scene; `story.md` gives the whole demo at a glance.

**Implementation notes (design review, 2026-10-05):**
- **Given to the agent as part of the run's own message, not the system prompt or the history** (C3, design reviewed): a `<project-notes-…>` block before the user's text (its tag this run's own: random) (`runAgent`'s `liveContext`), sent on every turn of the run and never stored, so stale copies never pile up in the history (within a run it's a stable prefix; across runs the cache restarts at the last run's message, as old results being elided already make it). Said "as at this run's start" (the agent's own changes since are its `edit_file` and `write_file` calls). Capped at 8,000 characters, cut at a line's end ("truncated: read_file the rest").
- **Scrubbed** (the scrubber keeps a `[secret]` already there as it is: text scrubbed twice never tells a value inside the word "secret"), whole before it's cut (and the content again each turn: a value known since; never the tags, which a short value would break); built once the vault is read. Labelled as data, not the user's words, and no embedded text (the story, a file's name) can close the block: its tag can't be guessed (the defence), and the common spellings of one in the text are neutralised (the rest would read as the user's). Names quoted (a comma or a line break in one never reads as more).
- **Each part on its own**: no story yet, an empty one, one too large (the user shortens it), one that can't be read (its refusal's code, never its bytes); the pages' and attachments' names (50 each, "more: list_files"), a folder that can't be listed said so.
- **Read at the run's start counts as a read** (`noteRead`, read_file's own: its hash), **never a whole one** (re-sent scrubbed again, it may show `[secret]` where a value known since was: a whole replace reads it first), never taking a whole read of the same bytes away: the agent can edit it without reading it again; a change the user makes during the run is still never written over. An empty file is replaced without the user's say (it loses nothing).
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

### 0.12 Attachments: material for the agent (designed 2026-10-05; images from tools and attaching built 2026-10-08)

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
- **E1, built 2026-10-08 (design reviewed):** `read_file` on an image shows it (`fitImage`,
  `packages/runtime/src/image.ts`): **never the file's bytes**, its pixels encoded again (no
  metadata: EXIF, GPS). Its header is read in Node first (PNG, JPEG, GIF, WebP: anything else,
  a BMP or text under an image's name, refused before a decoder sees it; at most 25 million
  pixels); decoded with `createImageBitmap` on a blank page of a throwaway context (never parsed
  as HTML; turned as its EXIF says; an animation's first frame, said when it has several), at most
  2,000 px on its long side, PNG (a JPEG on white over 3 MB), 10 s, stopped with the run.
  Whether the model takes images: OpenRouter's model list, asked once per model while the app
  runs (unknown: it does, logged); a model that doesn't: `look` and an image's read refuse.
  An image in `pages/` may be bytes the agent wrote (text copied in under an image's name):
  harmless, checked for secrets as written. **No tool ever puts an unmasked capture (a
  screenshot, a recording's frame) into `pages/` or `inputs/`**: a read would show it unmasked.
- **E2, built 2026-10-08 (design reviewed):** the composer's paperclip, a drop on the chat, a
  pasted image; up to 5 files a message, as chips (name, size: nothing attached is rendered).
  Main takes their **bytes** (never a path it would read), checks every file **by its content**
  before any is written (an image's header says its extension's format; text is UTF-8 without
  NUL; sizes: images 10 MB, .md/.txt 1 MB, .svg/.html 512 KB, as a page's file, so `copy_file`
  can adopt it; an image refused when the model takes none), then writes them with
  `ProjectFiles.attach` (the host's only: a safe name, never over another file: `logo-2.png`;
  inputs/ at most 200 MB, 1,000 files; a batch that fails partway removes what it wrote).
  The history keeps the text and a line naming the files; that run alone gets each image (E1) and
  each text up to 20,000 characters inside the run notes' block (scrubbed, its tag this run's own),
  a longer one named for `read_file`. The agent notes each new file in `story.md`. A name in another
  script becomes `attachment` (stated). Attached images are sent on every turn of their run (a
  stable prefix the provider can cache), at most 5.

### 0.13 The agent's file tools (designed 2026-10-05; the confined access built 2026-10-06, the tools 2026-10-07)

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
- **The confined access (C1, built 2026-10-06: `ProjectFiles` in `packages/project`, design reviewed):**
  - **No link followed anywhere:** on macOS the kernel refuses one anywhere in an open's path (`O_NOFOLLOW_ANY`, checked by a self-test at start: failing it, file access is off); every part is also checked first (good messages), each folder made one level at a time, and a file is checked from its descriptor (a regular file, on the project's disk, one hard link for a read). Opens never block (a FIFO).
  - **Writes:** a temporary sibling written exclusively, then linked into place for a new file (the kernel refuses an existing name) or renamed over the one whose hash was read; areas named as on disk (`Pages/` opens `pages/`); a new name the disk would take for another (case, accents) refused, asked of the disk itself.
  - **Limits:** a page's file 512 KB, a page folder (`pages/<name>/`) 20 MB, `pages/` 100 MB and 2,000 files, `story.md` 8,000 characters; a text read 1 MB (100 KB returned, by line range beyond), an image 10 MB, a listing 1,000 entries; a copy only to a page's own types (text, images, fonts: never one that runs).
  - **Residual (stated):** another local process swapping a folder for a link between a check and a rename, a folder creation or a listing (Node has no `renameat`, `opendir` takes no flags); elsewhere than macOS, an open checks each folder in turn. And a change saved in the instant between a write's hash check and its rename is replaced (no lock between processes).
- **The tools (C2, built 2026-10-07, design reviewed):** `list_files`, `read_file`, `write_file`, `edit_file`, `copy_file`, `delete_file` (packages/studio `file-tools.ts`).
  - **What the agent read** (the host's, per open project: outlives a studio remade): each file's hash, whether it saw the **whole** file **unscrubbed in one read** (parts never add up: a scrubbed part plus a clean one isn't the whole; a part read again never takes a whole read away), whether **it made** these bytes this session (wrote them, or copied them in). A whole replace (`write_file`, `copy_file` over a file) needs the file unchanged since, and seen whole or made by the agent (a file it made it knows: its own large page too); anything else only `edit_file`. `edit_file` and `delete_file` need a read, unchanged since; a file it can't read (a font, a file too large) is noted by its hash (`ProjectFiles.stat`: never its bytes), so it can be deleted (never replaced whole: it was never seen; deleted, then copied anew). A failure to keep a version says its error code only (never a path in the app's data). `edit_file` is done in `ProjectFiles.edit` on the **whole** file (never the 100 KB read), the rest byte for byte (a BOM, CRLF); its passage exactly once (overlapping ones count). A read is scrubbed **whole before a part is cut** (a value across lines, or across the cut, never shows half of it).
  - **A file holding a secret's value is never edited by the agent** (the read's own scrubber: what a read hides; refused before the passage is looked for, one answer whatever the passage: "found" or "not found" would answer a guess at the value, a character at a time). The user changes such a file.
  - **The user approves** a delete, and a whole replace of a file the agent didn't write this session (a card: "Replace a file?"), asked only once nothing else would refuse it (a file outside pages/, changed since); an edit asks no one.
  - **The agent never writes a secret's value** (decided 2026-10-07): every tool's arguments (content, a passage, a path, text it types in the browser) are checked at the tools' boundary by the scrubber that scrubs what it reads (every encoding it knows; values of 4 characters or more: a shorter one would match ordinary text, and stays a stated residual: scrubbed from what it reads, guessable): one holding a value is refused and **the run ends**, said in the chat without the value. The agent never knows a value, so one in what it wrote is a guess, and an answer echoing it back as `[secret]` would confirm it: one guess per run, never a guessing game (a secret that's a common word can stop a run innocently: the cost, accepted). An edit whose result holds a value it put together (two innocent pieces) ends the run too. A copy of the user's file holding one is refused (never into a page: its bytes as text, whatever its name), the run going on (not a guess). Residuals, stated: a value's length from a file's size and its scrubbed read; a UTF-16 text copied in unchecked (never readable by the agent: not text); JS concatenation and a value split across files.
  - **Never a hash or a file's bytes to the model** (an image read says its type and size: images reach the model in E1); every result scrubbed.
  - **Kept versions** (until history, M1-10): the bytes a replace or a delete loses, kept first in the app's data (`versions/<host scope>/`), 5 per file, 200 MB per project (oldest first), 30 days; a delete or replace whose version can't be kept is refused. Restoring them, revealing or forgetting them: BACKLOG.
  - The chat's row says the file (`pages/intro/index.html`; a copy `from → to`).
  - **For C3:** `story.md` is scrubbed before it's given in a run's message (it doesn't pass the tools' scrubbing). **For D1:** a page's network is blocked by the host (request interception), never by a CSP the agent writes; no `file:`, no navigation away; secrets never typed on an `html` app (a fake login on the local origin would be phishing).

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
version: 2
apps:                            # the apps the demo shows (§0.9); the first is where scenes start
  app:
    kind: web                    # web (v0) | html, electron (later)
    url: https://staging.acme.com
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
```

The scene's title, notes, duration and transition live in `scene.json` (§0.6). The scenario is only about **what happens in the app**.

Principles:
- **Step `id`s are stable.** The take and the composition refer to steps by ID, never by index.
- **A target keeps both the intent and the grounded locator.** The intent is used to heal the locator when it breaks.
- **Wait on a condition**, never a fixed sleep. `hold` and `pause` are presentation choices, not synchronization tools.
- **`caption` ≠ `instruction`:** the same step, told two ways (to watch vs to follow).

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
| **VHS** | `Hide/Show` (= our off-camera `setup`), `Wait` on a condition, `Sleep` as a presentation beat |
| **Screen Studio / Cap / OpenScreen / Screenize** | Camera: `Auto` vs `Manual{x,y}`, follow-cursor with dead zone, spring easing |
| **Arcade / Supademo** (documented features) | Per step: a **hotspot** on the target + a **callout** + **pan & zoom** onto a region |

### App actions (v0)
| Action | Key params | Notes |
|---|---|---|
| `goto` | `url`, `app?` | **Relative** to the app it names, else the scene's start app, a preset's own inside a preset (absolute and `//host` URLs are rejected, so a goto never leaves the project's apps; §0.9) |
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

Setup-only directive: `preset` (§2).

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
**No `if` / `repeat` in steps.** A demo must be **deterministic**: the same scenario gives the same film. Conditions make scenarios harder to read, harder to heal, and produce different videos from run to run. If something needs repeating, the agent writes out the steps.

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
  meta.json            viewport, DPR, fps, scenario hash, start app (name, URL), recordedAt, Kiframe version
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

**Limit to state clearly:** reverting history restores **objects**, not the live app. If the agent's last turn **created data in the app** (grounding runs steps), a revert doesn't delete it. The UI warns when a revert crosses app actions ("this won't undo what was created in Staging"); nothing cleans it up (§0.4).

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
