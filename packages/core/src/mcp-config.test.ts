import { Either, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  interpolateEnv,
  interpolateEnvRecord,
  McpConfigEntry,
  McpConfigFile,
  mcpNameError
} from "./mcp-config.js"

const decode = <A, I>(schema: Schema.Schema<A, I>, input: unknown) =>
  Schema.decodeUnknownEither(schema)(input)

describe("McpConfigFile", () => {
  it("decodes an opencode-shaped file and defaults enabled/headers/environment", () => {
    const result = decode(McpConfigFile, {
      mcp: {
        context7: { type: "remote", url: "https://mcp.context7.com/mcp" },
        local: { type: "local", command: ["npx", "-y", "some-mcp"] }
      }
    })
    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result)) {
      const remote = result.right.mcp["context7"]
      const local = result.right.mcp["local"]
      expect(remote).toMatchObject({ enabled: true, headers: {} })
      expect(local).toMatchObject({ enabled: true, environment: {} })
    }
  })

  it("defaults a missing mcp key to an empty record", () => {
    const result = decode(McpConfigFile, {})
    expect(Either.isRight(result) && Object.keys(result.right.mcp).length).toBe(0)
  })

  it("rejects invalid connection targets", () => {
    for (const url of ["", "not a URL", "file:///tmp/mcp", "https://user:secret@example.com/mcp"]) {
      expect(Either.isLeft(decode(McpConfigEntry, { type: "remote", url }))).toBe(true)
    }
    expect(Either.isLeft(decode(McpConfigEntry, { type: "local", command: [] }))).toBe(true)
    expect(Either.isLeft(decode(McpConfigEntry, { type: "local", command: [""] }))).toBe(true)
    expect(Either.isLeft(decode(McpConfigEntry, {
      type: "remote", url: "https://example.com", timeout: 0
    }))).toBe(true)
  })

  it("rejects an unknown type", () => {
    expect(Either.isLeft(decode(McpConfigEntry, { type: "stdio", command: ["x"] }))).toBe(true)
  })
})

describe("mcpNameError", () => {
  it("accepts ordinary names", () => {
    for (const name of ["context7", "gh_grep", "My-Server.v2"]) {
      expect(mcpNameError(name)).toBeNull()
    }
  })

  it("rejects reserved names case-insensitively and the jingler- prefix", () => {
    for (const name of ["browser", "Plan", "jingler-anything"]) {
      expect(mcpNameError(name)).toContain("reserved")
    }
  })

  it("rejects malformed names", () => {
    for (const name of ["", "-leading", "has space", "a".repeat(65)]) {
      expect(mcpNameError(name)).not.toBeNull()
    }
  })
})

describe("interpolateEnv", () => {
  it("substitutes placeholders and empties missing variables", () => {
    expect(interpolateEnv("Bearer {env:TOKEN}", { TOKEN: "abc" })).toBe("Bearer abc")
    expect(interpolateEnv("{env:GONE}/{env:TOKEN}", { TOKEN: "abc" })).toBe("/abc")
  })

  it("leaves literal values untouched", () => {
    expect(interpolateEnv("plain-secret", {})).toBe("plain-secret")
  })

  it("interpolates a record", () => {
    expect(interpolateEnvRecord(
      { a: "{env:X}", b: "{env:X}{env:Y}" },
      { Y: "y" }
    )).toEqual({ a: "", b: "y" })
  })
})
