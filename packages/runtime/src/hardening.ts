import type { LaunchOptions } from "playwright"

// Browser hardening for automation (APPROACHES §7.4, leak paths 4 and 5). Kiframe drives
// ephemeral contexts (`browser.newContext()`, never a persistent profile: nothing a run typed
// outlives it), with Playwright tracing never started (traces record `fill` arguments in plain
// text: the runtime never touches the context's trace API, and a test keeps it so).

/** Chromium features that save or fill credentials, or send form data out: off. */
const DISABLED_FEATURES = [
  "PasswordManagerOnboarding",
  "PasswordLeakDetection",
  "AutofillServerCommunication",
  "AutofillEnableAccountWalletStorage",
]

/** Launch options with password saving and autofill off; the caller's own options are kept. */
export function hardenedLaunchOptions(options: LaunchOptions = {}): LaunchOptions {
  const args = [...(options.args ?? [])]
  // One --disable-features: Chromium only reads the last one, so merge into the caller's.
  const at = args.findIndex((a) => a.startsWith("--disable-features="))
  const disabled = [
    ...(at === -1 ? [] : (args[at] as string).slice("--disable-features=".length).split(",")),
    ...DISABLED_FEATURES,
  ]
  if (at !== -1) args.splice(at, 1)
  args.push(`--disable-features=${[...new Set(disabled.filter(Boolean))].join(",")}`)
  args.push("--disable-save-password-bubble")
  return { ...options, args }
}
