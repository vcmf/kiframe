import * as z from "zod"
import { SecretName } from "@kiframe/schema"

// The vault's metadata (APPROACHES §7.4): what the agent may know about a secret, never its value.
// Local to this user and machine (never synced), next to the values in the OS keychain.

export const SecretKind = z.enum(["password", "username", "api_key", "text"])
export type SecretKind = z.infer<typeof SecretKind>

/** An http(s) origin, `scheme://host[:port]`, exactly as `URL.origin` writes it. */
export const Origin = z.string().refine((s) => {
  try {
    const url = new URL(s)
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin === s
  } catch {
    return false
  }
}, "an origin is scheme://host[:port], nothing after it")

/** What an element a secret goes into is (SECRETS-DESIGN §3 A1): checked at every use. */
export const ElementInfo = z.strictObject({
  tag: z.enum(["input", "textarea"]),
  /** An input's `type`; "textarea" for a textarea. */
  type: z.string().min(1).max(40),
  /** From a `<label>`, `aria-label` or `aria-labelledby` (not a placeholder); null without one. */
  label: z.string().max(200).nullable(),
})
export type ElementInfo = z.infer<typeof ElementInfo>

/** A pathname pattern: segments, `*` for any one segment (projects, then any id, then settings). */
export const PathPattern = z
  .string()
  .max(500)
  .regex(/^\/[^\s?#]*$/, "a path pattern is a pathname, `*` for any one segment")

/**
 * A step key (§3 A1): `scene:<scene>/<phase>/<step>`, `preset:<name>/<step>`, `interrupt:<rule>`
 * or `org:<org>/interrupt:<rule>`.
 */
export const StepKey = z
  .string()
  .max(300)
  .regex(
    /^(scene:[^/\s]+\/(setup|steps|teardown)\/[^/\s]+|preset:[^/\s]+\/[^/\s]+|interrupt:[^/\s]+|org:[^/\s]+\/interrupt:[^/\s]+)$/,
  )

/**
 * A user's approval (§3 A1): this step may type this secret into this target, on this origin and
 * paths, into this kind of element. Only the host's approval UI creates one.
 */
export const Grant = z.strictObject({
  /** The host's id for the project folder (or the org, for an org interrupt rule). */
  scope: z.string().min(1).max(200),
  stepKey: StepKey,
  secret: SecretName,
  origin: Origin,
  pathPattern: PathPattern,
  /** `canonicalTarget` of the step's target when approved. */
  target: z.string().min(2).max(4000),
  element: ElementInfo,
  grantedAt: z.iso.datetime(),
})
export type Grant = z.infer<typeof Grant>

export const SecretMeta = z.strictObject({
  name: SecretName,
  kind: SecretKind,
  /** Where it may be typed. */
  origins: z.array(Origin).min(1).max(20),
  updatedAt: z.iso.datetime(),
})
export type SecretMeta = z.infer<typeof SecretMeta>

export const VaultFile = z.strictObject({
  version: z.literal(1),
  secrets: z.array(SecretMeta).max(1000),
  grants: z.array(Grant).max(10_000).default([]),
})
export type VaultFile = z.infer<typeof VaultFile>
