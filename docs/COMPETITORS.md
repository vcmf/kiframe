# Kiframe: Competitive check

> Researched 2026-09-25, positioning revised 2026-09-26 after an adversarial review. Companion to [APPROACHES.md](./APPROACHES.md) §9 (prior art).
> Facts come from public pages (linked). Anything marked *(unverified)* couldn't be confirmed.

---

## 1. Demosmith ([demosmith.ai](https://demosmith.ai)): the closest commercial product

### Company
- **Founder:** Kolapo Oshodi, Toronto. Founded **January 2026**, and he describes himself as a solo founder ([site](https://kolapooshodi.me/)). The blog also names a "Jayden, Co-founder & CTO" *(conflicting, unverified)*.
- **ElevenLabs is not an investor.** Demosmith is in the **ElevenLabs Startup Grants** program, which gives free TTS credits to startups with fewer than 25 employees in exchange for a badge ([program](https://elevenlabs.io/startup-grants)). It also uses ElevenLabs for its voiceovers. No priced funding round found.
- **Timeline** ([changelog](https://demosmith.ai/changelog)): private beta Dec 2025 → waitlist removed Apr 2026 → interactive demos Sep 2026. They ship fast, about 20 releases in 9 months.

### Product
- **Input:** product URL + plain-English prompt + optional staging URL and **test credentials typed into their SaaS** + brand kit + language (29 languages).
- **Execution:** an autonomous agent in **their cloud browser**. It fills forms with fake data, and sessions are single-use.
- **Output from one run:** MP4 (up to 4K) + **interactive demo** + **docs** (Markdown/HTML/PDF). 9:16 is "soon".
- **Post-production:** voiceover, captions, auto-cuts, UI-aware zooms, music, blur, and a timeline editor.
- **Supported apps: web only.** No desktop, no mobile.
- **Speed:** under 10 min per demo. They claim "95% right first try".

### Pricing (homepage; `/pricing` returns 404)
| Plan | $/mo | AI min | Demos | Export |
|---|---|---|---|---|
| Trial | 0 (3 days) | 2 | 1 | 1080p |
| Starter | 40 | 20 | 10 | 1080p |
| Pro | 99 | 50 | 50 | 2K |
| Business | 250 | 150 | ∞ | 4K + API *(the FAQ says there's no API yet)* |

### Traction: weak public signals (your intuition holds up)
- **No Product Hunt launch** *(unverified)*. Nothing on Hacker News, Reddit or G2.
- The only "reviews" are on **Demosmith's own SEO blog** ("Demosmith vs Arcade/Loom/Supademo…").
- The founder's LinkedIn beta post got 23 reactions. Customer logos are small companies. They say most of their users are **"vibe coders"** (solo founders).
- On the other hand, they claim **"200+ product teams"** in public beta. Low buzz doesn't necessarily mean zero usage.

### Strengths / weaknesses
| Strengths | Weaknesses |
|---|---|
| Zero setup: URL in, video out in about 10 min | **One-shot**: if the agent fails, you rewrite the prompt and run it again |
| **Video + interactive demo + docs** from one run | No conversation with the agent, and no "ask the user when blocked" |
| 29 languages, brand kit, fake data | "Updating" = a full re-run. No detection of UI changes |
| Low entry price ($40) | **Credentials handed to their cloud.** No SOC 2 or subprocessor list found |
| | Web only. Probably no localhost or VPN apps (cloud browser) *(implied)* |
| | Metered in AI minutes. Depends heavily on ElevenLabs. A solo-founder vendor is a risk for B2B |

---

## 2. Other competitors found during the check

| Name | Type | Notes |
|---|---|---|
| [Bingeable](https://bingeable.ai/) | Commercial, cloud | Very similar to Demosmith: a cloud agent drives your app from a prompt and credentials. 15 languages, AI presenter ("digital twin"), social scheduling. $39/mo (4 videos) → $149/mo (12) |
| [aidemo](https://aidemo.top/) | OSS (MIT), local | **The closest to our philosophy:** a coding agent writes `storyboard.json`, which is replayed deterministically in *local* Chrome. Local Kokoro TTS. **Re-renders in CI when the product changes.** Works on localhost and behind auth. Needs a technical user |
| [AutoDemo](https://github.com/flavioduque/autodemo) | OSS (MIT), MCP | An agent drives the app, deterministic CDP capture, the edit is JSON, rendered with the HyperFrames compositor. Host allowlist. 0 stars |
| Trupeer | Commercial | AI avatars on top of screen recordings. Not driven by an agent |

Already known (APPROACHES.md §9): demo-machine, playwright-recast, programatic-demo, Arcade, Supademo, Storylane, Navattic, Guidde, Clueso, Screen Studio, Cap, OpenScreen.

---

## 3. Demosmith vs Kiframe

| | Demosmith | Kiframe (planned) |
|---|---|---|
| Where it runs | Their cloud | **User's machine** (desktop app) |
| Targets | Web | Web (v0), **Electron** (v0.1), Tauri partially (later) |
| Localhost, VPN, internal apps | Probably not | **Yes** |
| Scenario authoring | One prompt | **Conversation** with the agent + storyboard to approve |
| When the agent is stuck | Fails → run it again | **Asks the user** |
| Credentials | Typed into their SaaS | **Local vault. The LLM never sees the values** |
| Iteration | Manual editor | **Chat + editor**. Edits survive a re-record (step anchors, auto/manual) |
| UI changes | Full manual re-run | **Self-healing** + re-render |
| Zoom, cursor, captions, blur | ✅ | ✅ |
| Voiceover / languages | ✅ ElevenLabs, 29 | ❌ v0 (captions only), planned later |
| Written guide (docs) | ✅ (Docusmith) | ✅ **v0**: `guide` output, **updates itself** with the scenes |
| Interactive / HTML demo | ✅ | Later (`html-presentation`) |
| Brand kit | ✅ | Not yet specified |
| Price | $40–250/mo, metered | BYOK (cheap) or paid proxy |

---

## 4. What this means for Kiframe

1. **The market exists, and nobody owns it yet.** Several players (Demosmith, Bingeable) launched in 2025–2026 with the same promise ("URL + prompt → video"), and none of them shows strong traction. That's validation *and* a warning: the "wow" of the first video isn't enough to keep users.
2. **Our real angle is what the cloud tools can't do, plus maintenance:** local (localhost, VPN, Electron), **credentials and recordings that never leave the machine**, and above all **ongoing maintenance** (healing, re-recording only stale scenes, guides that stay current). Chat, a storyboard and a local vault are **parity features** that others can copy. Robustness and maintenance are the moat (APPROACHES §8b). That speaks to **teams that ship often** (B2B SaaS, dev tools) rather than vibe coders who make one video.
3. **Table stakes to plan for** (they all have them, so we'll need them too): brand kit (including cursor style), realistic fake data in forms, 9:16, **voiceover + multiple languages** (move it earlier on the roadmap?), and docs or step-by-step guide export from the same take.
4. **Pricing:** Demosmith and Bingeable sit at about **$40 entry → $150–250**, metered in AI minutes. **Unlimited re-renders** (no LLM involved) are a real selling point against that metering, but they're **not a structural cost advantage**: a cloud product can also re-render a stored recording cheaply, and their main variable costs are the LLM and TTS, not GPUs. BYOK removes our variable cost *and* our LLM revenue. Also note that free OSS tools (aidemo, demo-machine) squeeze a low BYOK price. Pricing stays open (APPROACHES §12).
5. **The open-source side is a threat too.** aidemo already does "local + CI re-render" for technical users. Our difference there is **UX** (chat, storyboard, editor, vault) for people who don't want to write JSON. It's still worth exposing a **CLI/MCP** so coding agents can drive Kiframe (a channel, not a competitor).
6. **Cheap tactics to copy:** "Kiframe vs X" SEO pages (that's how Demosmith gets traffic) and applying to **ElevenLabs Startup Grants** ourselves when voiceover arrives.

A note on "super expensive": for its target market, Demosmith is actually in line (Bingeable is the same price). What's expensive is the **metering per AI minute**, where every re-run costs. That's the point we can attack.
