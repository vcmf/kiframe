# Secrets pipeline: design (v0)

Status: **draft 2, for review** (2026-09-28). Replaces the M1-5 field binding and the M1-6 scanner timing rules. APPROACHES §7.4 states the goals; this document is the contract the code must keep. Every rule has an id (`I…`, `A…`, `R…`) that tests and code comments refer to. Draft 1's design review (15 findings, 8 severe) is folded in.

Why a redesign: M1-5 and M1-6 each needed three severe review rounds. Secret handling was spread over the runner, the vault, the recorder and the compositor with no written rules; the field binding was inferred from the DOM; the scanner's timing was patched hole by hole, and the compositor had timing rules of its own.

## 1. Threat model

**Assets.** Secret values (kinds `password`, `username`, `api_key`, `text`) and saved sessions (cookies, storage).

**Adversaries.**
- **A1, the agent:** confused or prompt-injected (by page content, a document, a chat message). It writes scenarios, presets, interrupt rules and compositions, and calls tools. It must never learn a value, nor get one typed, copied or shown where the user didn't approve.
- **A2, a hostile or buggy page:** any page the browser shows (iframes, redirects, popups). It can run JavaScript, change its DOM, move focus, navigate and spy on DOM APIs.
- **A3, artifact readers:** anyone who gets a take, a log, an error, a project folder (fingerprint crops included), git history, an export, or what the LLM provider (or our proxy) receives.
- **A4, viewers** of the final video, guide or screenshots.

**Out of the threat model.** Malware running as the user (it can read the keychain); the target app receiving the secret it's meant to receive and what it does with it (a hostile *same-origin* app can also display it in ways no scanner recognizes: I4 against it is best effort, §6); a user who approves a clearly worded bad request.

## 2. Invariants

- **I1, confinement.** A value exists only in the keychain, the vault's memory while resolving, the runtime's memory for the run (the *known values*), and the approved element's value. Never in the agent's or the LLM's context, in project, scenario, composition, take or history files (fingerprint crops included), in events, logs, errors or warnings, in URLs, in the OS clipboard, or in page JavaScript other than through the approved element.
- **I2, authorization.** A value is written only as §3 allows: an approved step, on an approved page, into an element with the approved signature, through a handle to that element.
- **I3, scrubbing.** Every string that leaves the runtime (events, errors, warnings, tool results, navigate URLs, reports) passes through the scrubber with every known value.
- **I4, visual.** No rendered frame and no model screenshot shows a known value unblurred, within the scanner's scope (§5). Where the runtime can't tell, it hides more (§5 R7), never less. Secret masks are derived from the take at render time and can't be removed or shortened by editing a composition.
- **I5, storage.** Sessions live in memory for one batch. Raw takes are sensitive: only in the take store (M1-8, encrypted at rest), never exported, never in git. Fingerprint crops of secret targets are taken before the write (§5 R9).
- **I6, browser.** Off-the-record contexts only; no Playwright traces; no JavaScript steps.

## 3. Authorization

**A1, grants.** A grant is `{ project, step key, secret, path, element signature, origin }`, stored **in the vault's metadata** (local, per user, per machine). Only the host's approval UI creates grants, from the user's answer; nothing the agent writes can (no project, scenario or composition field holds or names one).
- **Project:** the id the host assigned to the project folder and keeps outside it (a `project.json` id the agent could copy from another project is never trusted).
- **Step key:** `scene:<sceneId>/<phase>/<stepId>`, `preset:<name>/<stepId>` (one grant serves every scene using the preset), or `org:<orgId>/interrupt:<ruleId>` / `interrupt:<ruleId>` (a project rule never satisfies an org rule's grant). A `type` step with a secret reference must have an id, in every phase (schema rule).
- **Path:** the page's pathname when approved (query and hash dropped). The user can widen it to a pattern in the prompt (`/projects/*/settings`).
- **Element signature:** tag, `type`, `autocomplete`, `name`, and the owning form's action pathname (or "no form"). Not the locator: a healed or re-grounded target keeps its grant as long as it resolves, on the approved path, to an element with the same signature.
- **Origin:** the page's origin, one of the secret's origins.

**A2, at run time.** The runtime resolves the step's target; it must match **exactly one** visible element (no fallbacks and no `nth` for secret-typing steps: schema rule). It asks the vault with the use `{ project, step key, secret, origin, path, signature }`. The vault refuses (`secret-refused`, a message naming the secret and the reason, never a value) unless a grant matches all of them, and the kind rule holds: `password` only into `<input type=password>`; `username` and `api_key` only into `<input>` (text, email, tel, url, search, password); `text` into an `<input>` or `<textarea>`. The value is then written with `fill` on a handle to that element (its current value kept), never to whatever has focus; a navigation detaches the handle and nothing is written.

**A3, asking.** Approvals are asked **when the step is written**, which is when the agent grounds it: during the grounding run (M2-7), the runtime pauses at the unapproved step with its element resolved, and the host asks, built from the live page, never from agent-written text (`intent` is not shown): *"Type **acme.password** into this field (screenshot with the resolved element outlined; `input type=password name=pw`, form → `/session`) on **staging.acme.com/login**, for step *sign-in* of the *login* preset?"* Approve / approve for `/login*` / decline. Steps are asked in run order (the username before the password it leads to). A declined step leaves the scene `blocked`.

**A4, headless.** `kiframe record` and CI never ask: an ungranted use fails the step. Grants are per machine; running on another machine (CI) needs the user to export named grants to it (later: BACKLOG), never a field the agent can write.

**A5, after a write.** Once a secret was written in a context, until the context ends: `press` steps with copy, cut or paste shortcuts (Mod/Ctrl + C, X, V, A; Ctrl/Shift+Insert; Shift+Delete) and `drag` steps are refused, and the runtime never reads or sends the clipboard. (A copy would put the value in another field on the same origin or in the OS clipboard.)

**A6, interrupts.** A rule whose `do` types a secret is granted like a step, and its grant also covers the rule's `when` (a rule approved for a "Session expired" modal can't later be retargeted: a changed `when` asks again). Only `password` secrets in interrupt rules.

**A7, revocation.** The vault UI lists grants per project; removing one makes the step ask again. Removing a secret removes its grants.

## 4. Ownership

- **`@kiframe/vault`:** values (keychain), metadata, grants, `list`, `request`, `grant` / `revoke` (host only), `resolve(name, use)` enforcing A1, A2 and A6.
- **`runtime/secrets`** (new module, the runner's only secret code): the known values, the write (A2), the A5 refusals, the scrubber (I3), field tracking and the text scanner (R1–R8), and the region events. The runner calls it at hooks (step start, before an action, after the action, step end, page switch, run end); nothing else in the runner sees a value.
- **Recorder:** writes the region events as they come (with their own time bounds, §5). **Generators and compositor:** secret regions become masks at render time, straight from the take (not stored in `composition.json`: the composition can only add masks); the compositor applies each region's own `from`/`until`, with no timing rules of its own.
- **Host (desktop app, M4):** approval prompts, the vault UI, the project id, and the scene's complete known values (R6).

## 5. Visual rules (I4)

All times are **source time** (the take's clock); a freeze, a hold or a guide screenshot uses the source time of the frame it shows. "The last complete scan" is global across page switches and popups.

**Regions in the take.** A region is one take event, `sensitive { id, from, until, box(es) }`, written by the runtime with its whole time span: the compositor draws it exactly over `[from, until]`. `why`: `secret-field`, `secret-text`, `blind`.

- **R1, fields.** The element a secret was written to is blurred from the write until the end of the scene, following it (re-measured at every step boundary and page switch; an unsure measurement keeps the last box).
- **R2, scan scope.** Rendered text nodes (not `display:none` / `visibility:hidden`), `<input>` / `<textarea>` values (not password inputs) and `placeholder`s, in the top document and open shadow roots, **in the whole document** (boxes outside the viewport included: text about to scroll in is already known). Matched in Node, never in the page (I1): case-insensitive, whitespace-tolerant, per block (a value split across nodes, flex or grid items). Values shorter than 6 characters match as whole words only.
- **R3, complete scans.** A scan is complete when it read the page and measured every match. Failed, timed-out (2 s) or partly unsure scans are incomplete: they may start regions, never end one, and don't count as clean. A failure from a navigation (context destroyed) is retried as soon as the new document commits.
- **R4, spans.** A match seen by a complete scan at `s` and by the previous complete scan at `p`: its region covers `[p, s]` with the **hull** of its two boxes (it may have moved anywhere between them: a scroll, an animation). A match first seen at `s`: covered from `p` (or the scene start: R6), with the hull of its box and, if it came from outside the viewport, the viewport edge it came through. A match gone at `s`: covered until `s` plus the measured capture lag (R8).
- **R5, cadence.** A scan at every step boundary (after the action settles: never an earlier scan's result), on page scroll and resize events (a flag the page sets, no values in it), and at least every 300 ms while recording; one at a time.
- **R6, known values.** The host gives the runtime, before the scene starts, the values of every secret the scene can use: its steps, its presets (even skipped), the project's and org's interrupt rules, the environment's `requiredSecrets`. Resolving a value outside that set fails the scene. So every region is backdated to at most the last complete scan, and no rule depends on values arriving late.
- **R7, blind.** While values are known, a stretch with no complete scan for over 1 s (other than a navigation being retried, R3) is **blind**: the rendered video holds the last frame before it (a freeze, like a cut's) until the next complete scan. No full-frame blur flashes; the take records the stretch as a `blind` region.
- **R8, capture lag.** Measured per frame (the screencast frame's timestamp against the scan's time), not assumed; above the budget (500 ms), the stretch is blind (R7).
- **R9, crops and screenshots.** Model screenshots and fingerprint crops: page scripts and animations paused (CDP), complete scan, screenshot, complete scan, resume; every box of both painted over, in Node. Either scan incomplete: no image (an error the caller sees). Crops of a secret-typing target are taken before its write.
- **R10, keystrokes.** A secret write emits no `key` events; the keystroke overlay shows `••••`.

## 6. Out of scope (v0), stated

Text in `<select>` options, iframes, closed shadow roots, pseudo-elements, canvas, images or video (OCR); display tricks by the page itself (bidi overrides, reordering, glyph-swapping fonts: a hostile same-origin app already has the value); partial displays (`sk_live_…4242`); secrets into contenteditable fields; secrets on origins not in the secret's list (SSO pages: add the origin); running on another machine without an exported grant; several processes owning one vault file; the target page sending the value it received anywhere; Electron targets' persistent profile. Each is in BACKLOG with its user-visible effect.

## 7. Acceptance tests

The M1-7 exfiltration suite, plus:
- **Authorization:** an ungranted step is refused; the granted step moved after a `goto` to another path is refused; a new scene reusing a deleted scene's ids is refused (different project scope or path/signature); a healed target resolving to the same signature on the same path keeps its grant, one with another signature is refused; a locator matching two elements is refused; a password into a text input is refused even with a grant; a project rule with an org rule's id doesn't get its grant; a changed interrupt `when` is refused; after a write, `Mod+C` / `Mod+A` / `drag` are refused.
- **Scanner:** flicker (removed then back) never unblurred; a smooth scroll and a slide-in toast covered in every frame between scans (hull); text scrolling in from below covered on its way in; a timed-out scan ends nothing; a hung page gives a blind stretch (a held frame); a login redirect gives no blind stretch; a 10k-node page scans within budget.
- **Rendering check:** each case is rendered, and the region's pixels are asserted blurred in **every frame** where the fixture (whose timeline is known) shows the text; the composition can't remove a secret mask.

## 8. Migration

1. `runner.ts` split first, behaviour unchanged (secret code into `runtime/secrets`).
2. Schema: secret-typing steps need an id and a target without fallbacks or `nth`; `sensitive` events get `from` / `until` and `why: blind`; secret masks leave the composition.
3. Vault: grants (path, signature, step key, host project id) replace the field binding; `unbind` goes.
4. Runtime: the A2 write and A5 refusals; the scanner on R2–R9; approvals asked through a `requestApproval` hook the grounding run provides (M2-4 later wires the UI).
5. Recorder, generators, compositor: regions applied as written, masks derived at render time, blind stretches as held frames; the rendering check.
