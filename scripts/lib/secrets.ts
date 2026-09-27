// Phase 0 scripts: secrets from the environment (a git-ignored `.env` at the repo root, see
// .env.example). Secret `a.b` is read from `A_B`. Only the names given are resolvable.
import { existsSync } from "node:fs"

export function loadDotEnv(): void {
  if (existsSync(".env")) process.loadEnvFile(".env")
}

export const envName = (secret: string) => secret.toUpperCase().replace(/[^A-Z0-9]/g, "_")

/** A resolver for the runner: throws (never returns "") when a secret isn't provided. */
export function envSecretResolver(names: readonly string[]): (name: string) => string {
  return (name) => {
    const value = process.env[envName(name)]
    if (!names.includes(name) || value === undefined || value === "") throw new Error("unavailable")
    return value
  }
}
