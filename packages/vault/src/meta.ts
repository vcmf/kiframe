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

/**
 * The kind of field a secret was first typed into (an input's `type`, `textarea`…). A later use
 * must be the same kind: a password never goes into a text or search box. Deliberately not the
 * locator nor `autocomplete`: they change with healing, fallbacks and anti-autofill tricks.
 */
export const FieldBinding = z.strictObject({ inputType: z.string().min(1).max(40) })
export type FieldBinding = z.infer<typeof FieldBinding>

export const SecretMeta = z.strictObject({
  name: SecretName,
  kind: SecretKind,
  /** Where it may be typed. */
  origins: z.array(Origin).min(1).max(20),
  /** Bound at first use; cleared only by the user (`unbind`). */
  field: FieldBinding.optional(),
  updatedAt: z.iso.datetime(),
})
export type SecretMeta = z.infer<typeof SecretMeta>

export const VaultFile = z.strictObject({
  version: z.literal(1),
  secrets: z.array(SecretMeta).max(1000),
})
export type VaultFile = z.infer<typeof VaultFile>
