# Secrets pipeline: design (v0)

Status: **draft for review** (2026-09-28). Replaces the M1-5 field binding and the M1-6 scanner timing rules. APPROACHES §7.4 states the goals; this document is the contract the code must keep. Every rule has an id (`I…`, `R…`) that tests and code comments refer to.

Why a redesign: M1-5 and M1-6 each needed three severe review rounds. Secret handling was spread over the runner, the vault, the recorder and the compositor with no written rules, the field binding was inferred from the DOM (it broke on healing and still couldn't tell two same-origin text boxes apart), and the scanner's timing was patched hole by hole.

## 1. Threat model

**Assets.** Secret values (kinds `password`, `username`, `api_key`, `text`) and saved sessions (cookies, storage).

**Adversaries.**
- **A1, the agent:** confused or prompt-injected (by page content, a document, a chat message). It writes scenarios, presets and interrupt rules, and calls tools. It must never learn a value, nor get one typed where the user didn't approve.
- **A2, a hostile or buggy page:** any page the browser shows, same origin as the app or not (iframes, redirects, popups). It can run JavaScript, change its DOM, move focus, navigate and spy on DOM APIs.
- **A3, artifact readers:** anyone who gets a take, a log, an error, a project folder, git history, an export, or what the LLM provider (or our proxy) receives.
- **A4, viewers** of the final video, guide or screenshots.

**Out of the threat model.** Malware running as the user (it can read the keychain); the target app receiving the secret it's meant to receive and what its servers do with it; a user who approves a bad request (we make requests clear, we don't second-guess them).

## 2. Invariants

- **I1, confinement.** A value exists only in the keychain, the vault's memory while resolving, the runtime's memory for the run (the *known values*), and the approved element's value. Never in the agent's or the LLM's context, in project, scenario, take or history files, in events, logs, errors or warnings, in URLs, or in page JavaScript other than through the approved element.
- **I2, authorization.** A value is written only by a `type` step that has a **user approval** (§3), for that secret, that step, and that step's current target; on one of the secret's origins; into the element that target resolves to, which must be an `<input>` or `<textarea>` (a `password` secret: an `<input type=password>`); written through a handle to that element (a navigation detaches it: nothing is written anywhere).
- **I3, scrubbing.** Every string that leaves the runtime (events, errors, warnings, tool results, navigate URLs, reports) passes through the scrubber with every known value.
- **I4, visual.** No frame of a take's rendered output and no screenshot sent to the model shows a known value unblurred, as far as the scanner's scope (§5) sees it. Where the runtime can't tell, it blurs more (the whole frame), never less.
- **I5, storage.** Sessions live in memory for one batch. Raw takes (unblurred frames) are sensitive: only in the take store (M1-8: encrypted at rest), never exported, never in git.
- **I6, browser.** Off-the-record contexts only; no Playwright traces; no JavaScript steps.

## 3. Approvals (I2)

**What is approved.** A *grant*: `{ project, step key, secret, target hash, origins }`, stored **in the vault's metadata** (local, per user, per machine), never in the project. The agent can't write it: grants are created only by the host's approval UI, from the user's answer.

- **Step key:** `scene:<sceneId>/<phase>/<stepId>`, `preset:<name>/<stepId>` (project presets: one grant serves every scene) or `interrupt:<ruleId>`. A `type` step with a secret reference **must have an id**, in every phase (schema rule; today setup, teardown and preset steps may omit it).
- **Target hash:** SHA-256 of the step target's canonical JSON *without* its healing metadata (`intent`, `fingerprint`), fallbacks and `nth` included (they decide which element is used). Sorted keys, defaults dropped (`exact: false`).
- **Origins:** the secret's origins at approval time; typing still requires the page's origin to be one of them.

**When it's asked.** The host compares the scenes the agent wrote with the grants: a secret-typing step with no grant, or whose target hash changed (the agent re-grounded or healed it), gets an approval request in the chat: *"Type **acme.password** into **the Password field** (screenshot, highlighted) on **staging.acme.com**, in step *sign-in* of the *login* preset?"* Approve / decline. Several at once for one scene. A declined step stays unapproved; the scene can't be recorded (status `blocked`).

**At run time** the runtime asks the vault with the use: `{ project, step key, target hash, origin, element kind }`. No grant, a different hash, a disallowed origin, or a password into a non-password input: refused (`secret-refused`, with a message naming the secret and the reason, never a value). Headless runs (`kiframe record`, CI) never ask: an unapproved step fails.

**Revocation.** The vault UI lists grants per project; removing one makes the step ask again. Removing a secret removes its grants.

**What this replaces.** The M1-5 first-use binding (field kind recorded at first use, `unbind`) is removed.

## 4. Ownership

- **`@kiframe/vault`:** values (keychain), metadata, **grants**, `list`, `request`, `grant` / `revoke` (host only), `resolve(name, use)` checking I2's grant, origin and kind rules.
- **`runtime/secrets` (new module, the runner's only secret code):** the known values, `typeSecret` (resolve, then write through the element handle: I2), the scrubber (I3), the secret-field tracking and the text scanner loop (I4), emitting `sensitive` events. The runner calls it at hooks (step start, after the action, step end, page switch, run end); nothing else in the runner touches values.
- **Recorder:** turns `secret_field` / `secret_text` / `blind` events into take events. **Compositor:** renders them, including the full-frame blur of R6.
- **Host (desktop app, M4):** approval requests and the vault UI; fills the known values for a scene's secrets (§5 R5) from the vault.

## 5. Visual rules (I4)

Fields:
- **R1.** The element a secret was written to is blurred from the moment of the write until the end of the scene, following it (re-measured at every step boundary and page switch; unsure measurements keep the last box).

Text (the DOM-text scanner):
- **R2, scope.** Visible text nodes and `<input>` / `<textarea>` values (not password inputs) in the top document and open shadow roots, in the viewport. Matched in Node, never in the page (I1): case-insensitively, whitespace-tolerant, per block (a value split across nodes, flex or grid items is found).
- **R3, complete scans.** A scan is *complete* when it read the page and measured every match. A failed, timed-out (2 s) or partly unsure scan is *incomplete*: it may open regions, never ends one, and doesn't count as clean.
- **R4, regions.** A region is one box (ids never reused). It is blurred from the start of the last *complete* scan that ran with the same known values (the scene start if none), and until the first complete scan that no longer sees it, plus the capture lag (250 ms, the compositor's). So a region never ends early and never starts late, whatever happens between scans.
- **R5, known values.** Values resolved in the run, plus the values of every secret the scene's steps reference (filled by the host, so a skipped login still blurs "Logged in as bob@acme.com"). When the set grows, the clean point resets to the scene start (R4).
- **R6, blind.** While values are known, if no complete scan has finished for 1 s (a hung page, constant re-rendering), the whole frame is blurred from the last complete scan until the next one (a `blind` event: `sensitive` region `blind:<n>`, full frame). Fails closed instead of guessing.
- **R7, cadence.** A scan at every step boundary (after the action settles: the page as the step left it, never an earlier scan's result), and every 300 ms while recording (one at a time).

Model screenshots:
- **R8.** Complete scan, screenshot, complete scan; every box of both painted over, in Node. Either scan incomplete: no screenshot (an error the agent sees).

## 6. Out of scope (v0), stated

Text in `<select>` options, iframes, closed shadow roots, canvas, images or video (OCR); secrets into contenteditable fields; secrets typed on origins not in the secret's list (SSO pages: add the origin); several processes owning one vault file; the target page sending the value it received anywhere; Electron targets' persistent profile (they keep what was typed in their own storage). Each is in BACKLOG with its user-visible effect.

## 7. Acceptance tests

The M1-7 exfiltration suite, plus:
- **Approvals:** an unapproved step is refused; a changed target (healed) is refused until approved again; a grant for another project, scene or secret doesn't apply; the scenario file can't create a grant (no field for it); a password into a text input is refused even with a grant.
- **Scanner rules:** a flicker (text removed then back) is never unblurred (R4); a scan that times out ends nothing (R3); a hung page produces a `blind` region (R6); a value resolved mid-scene blurs its earlier occurrences from the scene start (R5); a region's end is at least 250 ms after its last complete absence (R4).
- **Rendering check:** for each case, render the take and assert the region's pixels are blurred in every frame where the fixture shows the text (the fixture's own timeline is known), not just that events exist.

## 8. Migration

1. `runner.ts` split first, behaviour unchanged (secrets code moves into `runtime/secrets`).
2. Vault: grants replace the field binding; `resolve` takes the new use; `unbind` removed.
3. Schema: secret-typing steps need an id in every phase.
4. Runtime: `typeSecret` computes the target hash and the element kind; scanner rules R3–R7 with `blind`; `RunOptions` gets the project id and scene id (step keys), and `knownSecretValues` stays the host's job.
5. Recorder and compositor: `blind` regions; the rendering check.
