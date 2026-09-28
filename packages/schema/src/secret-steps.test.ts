import { describe, expect, it } from "vitest"
import { parseProjectYaml, parseScenarioYaml } from "./io.ts"

// SECRETS-DESIGN §3: a step typing a secret has an id (approvals are keyed by it) and one exact
// grounded target (no fallbacks, no nth).
const scenario = (yaml: string) => () => parseScenarioYaml(`version: 1\n${yaml}`)
const typeSecret = (extra: string) =>
  `{ action: type, target: { by: label, name: Password${extra} }, value: "{{secrets.acme.password}}" }`

describe("secret-typing steps", () => {
  it("need an id in setup and teardown", () => {
    expect(
      scenario(`setup: [${typeSecret("")}]\nsteps: [{ id: a, action: pause, ms: 1 }]`),
    ).toThrow(/needs an id/)
    expect(
      scenario(`teardown: [${typeSecret("")}]\nsteps: [{ id: a, action: pause, ms: 1 }]`),
    ).toThrow(/needs an id/)
    expect(
      scenario(
        `setup: [{ id: pw, ${typeSecret("").slice(2)}]\nsteps: [{ id: a, action: pause, ms: 1 }]`,
      ),
    ).not.toThrow()
  })

  it("need an id in a preset", () => {
    const project = (step: string) => () =>
      parseProjectYaml(`version: 1
target: { kind: web, url: "https://app.example.com", viewport: { width: 800, height: 600 } }
presets:
  login:
    steps: [${step}]
`)
    expect(project(typeSecret(""))).toThrow(/needs an id/)
    expect(project(`{ id: pw, ${typeSecret("").slice(2)}`)).not.toThrow()
  })

  it("need one exact grounded target: no fallbacks, no nth, no intent-only target", () => {
    const step = (target: string) =>
      scenario(
        `steps:\n  - { id: pw, action: type, target: ${target}, value: "{{secrets.acme.password}}" }`,
      )
    expect(step("{ by: label, name: Password, fallbacks: [{ by: label, name: Pass }] }")).toThrow(
      /one exact grounded target/,
    )
    expect(step("{ by: label, name: Password, nth: 0 }")).toThrow(/one exact grounded target/)
    expect(step(`{ intent: "the password" }`)).toThrow(/one exact grounded target/)
    expect(step(`{ by: label, name: Password, intent: "the password" }`)).not.toThrow()
  })

  it("leave ordinary typing alone", () => {
    expect(
      scenario(
        `setup: [{ action: type, target: { by: label, name: Name, nth: 1 }, value: "Bob" }]\nsteps: [{ id: a, action: pause, ms: 1 }]`,
      ),
    ).not.toThrow()
  })
})
