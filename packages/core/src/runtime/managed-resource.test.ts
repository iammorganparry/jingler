import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  ManagedMcpServer,
  ManagedResourceScope,
  ResourceImportResult
} from "./managed-resource.js"

const base = {
  id: "linear",
  name: "Linear",
  kind: "mcp",
  enabled: true,
  trust: "operator-approved",
  scope: { kind: "device-local", targetId: "desktop" },
  provenance: {
    origin: "claude",
    sourceRoot: "/Users/operator/.claude",
    sourcePath: "mcp.json",
    importedAt: "2026-08-10T00:00:00.000Z"
  },
  availability: { state: "available", targetId: "desktop", reason: null }
}

describe("managed resource schemas", () => {
  it("keeps MCP metadata redacted by rejecting secret values", () => {
    expect(() => Schema.decodeUnknownSync(ManagedMcpServer)({
      ...base,
      transport: "http",
      url: "https://mcp.example.test",
      headerKeys: ["Authorization"],
      headers: { Authorization: "Bearer secret" }
    }, { onExcessProperty: "error" })).toThrow()
  })

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
