import { describe, expect, it } from "vitest"
import { codexMcpOverrides, opencodeMcpConfig, type ParsedMcpServer } from "./mcp-config.js"

/**
 * The write-side of MCP config: rendering the resolved OpenConnector server into
 * codex's `-c` overrides and opencode's config block, so all harnesses load the
 * same shared server. Both are pure, so we assert the exact rendered shapes.
 */

const remote = (headers: Record<string, string> = { Authorization: "Bearer tok" }): ParsedMcpServer => ({
  server: {
    name: "open-connector",
    cli: "codex",
    transport: "http",
    scope: "user",
    target: "https://oc.test/mcp",
    envKeys: [],
    headerKeys: Object.keys(headers),
    enabled: true
  },
  launch: { transport: "http", args: [], env: {}, url: "https://oc.test/mcp", headers }
})

const stdio: ParsedMcpServer = {
  server: {
    name: "local",
    cli: "codex",
    transport: "stdio",
    scope: "user",
    target: "npx x",
    envKeys: [],
    headerKeys: [],
    enabled: true
  },
  launch: { transport: "stdio", command: "npx", args: ["x"], env: {}, headers: {} }
}

describe("codexMcpOverrides", () => {
  it("renders url + header overrides with TOML-safe (JSON) string values", () => {
    expect(codexMcpOverrides(remote())).toEqual([
      'mcp_servers.open-connector.url="https://oc.test/mcp"',
      'mcp_servers.open-connector.http_headers.Authorization="Bearer tok"'
    ])
  })

  it("is empty for a missing entry or a non-remote (stdio) one", () => {
    expect(codexMcpOverrides(null)).toEqual([])
    expect(codexMcpOverrides(undefined)).toEqual([])
    expect(codexMcpOverrides(stdio)).toEqual([])
  })
})

describe("opencodeMcpConfig", () => {
  it("renders a remote mcp block keyed by the server name", () => {
    expect(opencodeMcpConfig(remote())).toEqual({
      mcp: {
        "open-connector": {
          type: "remote",
          url: "https://oc.test/mcp",
          enabled: true,
          headers: { Authorization: "Bearer tok" }
        }
      }
    })
  })

  it("omits headers when there are none, and is empty for a missing/stdio entry", () => {
    expect(opencodeMcpConfig(remote({}))).toEqual({
      mcp: { "open-connector": { type: "remote", url: "https://oc.test/mcp", enabled: true } }
    })
    expect(opencodeMcpConfig(null)).toEqual({})
    expect(opencodeMcpConfig(stdio)).toEqual({})
  })
})
