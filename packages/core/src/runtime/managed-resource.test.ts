import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { ManagedResourceScope, ResourceImportResult } from "./managed-resource.js"

describe("managed resource schemas", () => {
  it("distinguishes portable and target-local scopes", () => {
    expect(Schema.decodeUnknownSync(ManagedResourceScope)({
      kind: "portable",
      allowedTargets: ["desktop", "device-1"]
    })).toEqual({ kind: "portable", allowedTargets: ["desktop", "device-1"] })
    expect(Schema.decodeUnknownSync(ManagedResourceScope)({
      kind: "device-local",
      targetId: "device-1"
    })).toEqual({ kind: "device-local", targetId: "device-1" })
  })

  it("reports imported ids and independent skipped diagnostics", () => {
    expect(Schema.decodeUnknownSync(ResourceImportResult)({
      imported: ["deploy"],
      skipped: [{
        sourcePath: "broken/SKILL.md",
        kind: "skill",
        code: "malformed",
        message: "Missing frontmatter"
      }]
    })).toMatchObject({ imported: ["deploy"], skipped: [{ code: "malformed" }] })
  })
})
