import { describe, expect, it } from "vitest"
import type { RemoteMcpServer } from "./adapter.js"
import { codexMcpOverrides, opencodeMcpConfig } from "./mcp-config.js"

/**
 * The write-side of MCP config: rendering normalized remote attachments into
 * Codex's ordered `-c` overrides and opencode's single `mcp` object. Both are
 * pure, so these assertions pin the exact launch shapes without spawning a CLI.
 */

const OPEN_CONNECTOR: RemoteMcpServer = {
  name: "open-connector",
  url: "https://connector.example/mcp",
  headers: {
    Authorization: "Bearer connector-token",
    "X-Connector-Scope": "workspace"
  }
}

const PREVIEW_BROWSER: RemoteMcpServer = {
  name: "jingler-browser",
  url: "http://127.0.0.1:32123/mcp",
  headers: { Authorization: "Bearer preview-token" }
}

describe("codexMcpOverrides", () => {
  it("renders independent URL and HTTP-header overrides for every server in order", () => {
    expect(codexMcpOverrides([OPEN_CONNECTOR, PREVIEW_BROWSER])).toEqual([
      'mcp_servers.open-connector.url="https://connector.example/mcp"',
      'mcp_servers.open-connector.http_headers.Authorization="Bearer connector-token"',
      'mcp_servers.open-connector.http_headers.X-Connector-Scope="workspace"',
      'mcp_servers.jingler-browser.url="http://127.0.0.1:32123/mcp"',
      'mcp_servers.jingler-browser.http_headers.Authorization="Bearer preview-token"'
    ])
  })

  it("is empty for an absent or empty collection", () => {
    expect(codexMcpOverrides(null)).toEqual([])
    expect(codexMcpOverrides(undefined)).toEqual([])
    expect(codexMcpOverrides([])).toEqual([])
  })

  it("keeps either available server independently", () => {
    expect(codexMcpOverrides([PREVIEW_BROWSER])).toEqual([
      'mcp_servers.jingler-browser.url="http://127.0.0.1:32123/mcp"',
      'mcp_servers.jingler-browser.http_headers.Authorization="Bearer preview-token"'
    ])
    expect(codexMcpOverrides([OPEN_CONNECTOR])).toEqual([
      'mcp_servers.open-connector.url="https://connector.example/mcp"',
      'mcp_servers.open-connector.http_headers.Authorization="Bearer connector-token"',
      'mcp_servers.open-connector.http_headers.X-Connector-Scope="workspace"'
    ])
  })

  it("renders a duplicate name once and keeps its first attachment", () => {
    expect(
      codexMcpOverrides([
        OPEN_CONNECTOR,
        {
          name: OPEN_CONNECTOR.name,
          url: "https://duplicate.example/mcp",
          headers: { Authorization: "Bearer duplicate-token" }
        }
      ])
    ).toEqual([
      'mcp_servers.open-connector.url="https://connector.example/mcp"',
      'mcp_servers.open-connector.http_headers.Authorization="Bearer connector-token"',
      'mcp_servers.open-connector.http_headers.X-Connector-Scope="workspace"'
    ])
  })
})

describe("opencodeMcpConfig", () => {
  it("renders both entries in one mcp object with per-server headers intact", () => {
    expect(opencodeMcpConfig([OPEN_CONNECTOR, PREVIEW_BROWSER])).toEqual({
      mcp: {
        "open-connector": {
          type: "remote",
          url: "https://connector.example/mcp",
          enabled: true,
          headers: {
            Authorization: "Bearer connector-token",
            "X-Connector-Scope": "workspace"
          }
        },
        "jingler-browser": {
          type: "remote",
          url: "http://127.0.0.1:32123/mcp",
          enabled: true,
          headers: { Authorization: "Bearer preview-token" }
        }
      }
    })
  })

  it("omits empty headers and is empty for an absent collection", () => {
    expect(
      opencodeMcpConfig([
        { name: "public-tools", url: "https://public.example/mcp", headers: {} }
      ])
    ).toEqual({
      mcp: {
        "public-tools": {
          type: "remote",
          url: "https://public.example/mcp",
          enabled: true
        }
      }
    })
    expect(opencodeMcpConfig(null)).toEqual({})
    expect(opencodeMcpConfig(undefined)).toEqual({})
    expect(opencodeMcpConfig([])).toEqual({})
  })

  it("keeps either available server independently", () => {
    expect(opencodeMcpConfig([PREVIEW_BROWSER])).toEqual({
      mcp: {
        "jingler-browser": {
          type: "remote",
          url: "http://127.0.0.1:32123/mcp",
          enabled: true,
          headers: { Authorization: "Bearer preview-token" }
        }
      }
    })
    expect(opencodeMcpConfig([OPEN_CONNECTOR])).toEqual({
      mcp: {
        "open-connector": {
          type: "remote",
          url: "https://connector.example/mcp",
          enabled: true,
          headers: {
            Authorization: "Bearer connector-token",
            "X-Connector-Scope": "workspace"
          }
        }
      }
    })
  })

  it("renders a duplicate name once and keeps its first attachment", () => {
    expect(
      opencodeMcpConfig([
        PREVIEW_BROWSER,
        {
          name: PREVIEW_BROWSER.name,
          url: "http://127.0.0.1:49999/mcp",
          headers: { Authorization: "Bearer duplicate-token" }
        }
      ])
    ).toEqual({
      mcp: {
        "jingler-browser": {
          type: "remote",
          url: "http://127.0.0.1:32123/mcp",
          enabled: true,
          headers: { Authorization: "Bearer preview-token" }
        }
      }
    })
  })
})
