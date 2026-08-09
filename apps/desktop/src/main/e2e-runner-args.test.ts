import { describe, expect, it } from "vitest"
import { normalizeE2eArgs } from "../../scripts/run-e2e-args.js"

describe("desktop E2E argument forwarding", () => {
  it("removes pnpm's separator so spec paths remain Playwright filters", () => {
    expect(normalizeE2eArgs(["--", "remote-environments.spec.ts", "projects-and-workspaces.spec.ts"]))
      .toEqual(["remote-environments.spec.ts", "projects-and-workspaces.spec.ts"])
  })

  it("preserves normal Playwright options and unfiltered full-suite runs", () => {
    expect(normalizeE2eArgs(["auth.spec.ts", "--workers=1"])).toEqual(["auth.spec.ts", "--workers=1"])
    expect(normalizeE2eArgs([])).toEqual([])
  })
})
