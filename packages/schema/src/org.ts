import * as z from "zod"
import { claimIds, CssSelector, OrgId, SecretName, withoutCredentials } from "./common.ts"
import { guarded } from "./guards.ts"
import { InterruptRule } from "./project.ts"
import { RuleName } from "./settings.ts"
import { Brand, StyleOverride } from "./style.ts"

// Org and user settings (APPROACHES §10c). Org settings are synced from the server and shared by
// every project of the org; user preferences never change an output.

/**
 * Where a project's app runs: its URL and how careful the agent must be there. Risky steps can only
 * be pre-approved on a sandbox (APPROACHES §7.2).
 */
export const Environment = z
  .strictObject({
    name: RuleName,
    /** http(s) only, and no embedded credentials (use the vault). */
    url: withoutCredentials(z.url({ protocol: /^https?$/ })),
    /** Demo or staging data that may be changed and reset. */
    sandbox: z.boolean().default(false),
    /** Risky teardown steps run without asking (sandbox only). */
    preApproveTeardown: z.boolean().default(false),
    /** Secret names each member fills in on their own machine (values are never synced). */
    requiredSecrets: z.array(SecretName).default([]),
  })
  .refine((e) => !e.preApproveTeardown || e.sandbox, {
    message: "teardowns can only be pre-approved on a sandbox environment",
    path: ["preApproveTeardown"],
  })
export type Environment = z.infer<typeof Environment>

/** Unguarded: internal only, use the guarded export. */
const OrgSettingsBase = z
  .strictObject({
    version: z.literal(1),
    brand: Brand.prefault({}),
    style: StyleOverride.optional(),
    environments: z.array(Environment).default([]),
    /** The shared rule bank: popups to dismiss and elements to hide, for every project. */
    rules: z
      .strictObject({
        interrupts: z.array(InterruptRule).default([]),
        hide: z.array(CssSelector).default([]),
      })
      .prefault({}),
    llm: z
      .strictObject({
        /** `proxy-only`: members can't use their own key (billing and data policy of the org). */
        policy: z.enum(["byok-allowed", "proxy-only"]).default("byok-allowed"),
      })
      .prefault({}),
  })
  .superRefine((s, ctx) => {
    const names = new Set<string>()
    s.environments.forEach((e, i) => {
      if (names.has(e.name)) {
        ctx.addIssue({
          code: "custom",
          message: `environment "${e.name}" is declared twice`,
          path: ["environments", i, "name"],
        })
      }
      names.add(e.name)
    })
    claimIds(s.rules.interrupts, ["rules", "interrupts"], ctx)
  })

/** Org settings, with whole-document guards. Interrupt actions may type secrets. */
export const OrgSettings = guarded(OrgSettingsBase, [["rules", "interrupts", "#", "do", "value"]])
export type OrgSettings = z.infer<typeof OrgSettingsBase>

/** Unguarded: internal only, use the guarded export. */
const UserPreferencesBase = z.strictObject({
  version: z.literal(1),
  /** UI language, a BCP 47 tag (`en`, `fr`, `pt-BR`, `zh-Hant`, `es-419`, `fil`). */
  language: z
    .string()
    .regex(
      /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/,
      "a language is a BCP 47 tag like en, pt-BR or zh-Hant",
    )
    .default("en"),
  theme: z.enum(["system", "light", "dark"]).default("system"),
  /** The org Kiframe opens by default. */
  defaultOrgId: OrgId.optional(),
})
export const UserPreferences = guarded(UserPreferencesBase)
export type UserPreferences = z.infer<typeof UserPreferencesBase>
