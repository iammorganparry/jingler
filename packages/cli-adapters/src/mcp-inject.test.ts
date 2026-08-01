import { describe, expect, it } from "vitest"
import type { RemoteMcpServer } from "./adapter.js"
import {
  codexMcpEnvironment,
  codexMcpOverrides,
  opencodeMcpEntries
} from "./mcp-config.js"

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
  headers: { Authorization: "Bearer preview-token" },
  headerEnvironment: { Authorization: "JINGLER_BROWSER_MCP_AUTHORIZATION" }
}

describe("codexMcpOverrides", () => {
  it("renders independent URL and HTTP-header overrides for every server in order", () => {
    expect(codexMcpOverrides([OPEN_CONNECTOR, PREVIEW_BROWSER])).toEqual([
      "features.tool_call_mcp_elicitation=false",
      'mcp_servers.open-connector.url="https://connector.example/mcp"',
      'mcp_servers.open-connector.http_headers.Authorization="Bearer connector-token"',
      'mcp_servers.open-connector.http_headers.X-Connector-Scope="workspace"',
      'mcp_servers.jingler-browser.url="http://127.0.0.1:32123/mcp"',
      'mcp_servers.jingler-browser.env_http_headers.Authorization="JINGLER_BROWSER_MCP_AUTHORIZATION"',
      'shell_environment_policy.filters.JINGLER_BROWSER_MCP_AUTHORIZATION="exclude"'
    ])
  })

  it("disables duplicate tool approvals even when connectors come from Codex config", () => {
    expect(codexMcpOverrides(null)).toEqual(["features.tool_call_mcp_elicitation=false"])
    expect(codexMcpOverrides(undefined)).toEqual(["features.tool_call_mcp_elicitation=false"])
    expect(codexMcpOverrides([])).toEqual(["features.tool_call_mcp_elicitation=false"])
  })

  it("keeps either available server independently", () => {
    expect(codexMcpOverrides([PREVIEW_BROWSER])).toEqual([
      "features.tool_call_mcp_elicitation=false",
      'mcp_servers.jingler-browser.url="http://127.0.0.1:32123/mcp"',
      'mcp_servers.jingler-browser.env_http_headers.Authorization="JINGLER_BROWSER_MCP_AUTHORIZATION"',
      'shell_environment_policy.filters.JINGLER_BROWSER_MCP_AUTHORIZATION="exclude"'
    ])
    expect(codexMcpOverrides([OPEN_CONNECTOR])).toEqual([
      "features.tool_call_mcp_elicitation=false",
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
      "features.tool_call_mcp_elicitation=false",
      'mcp_servers.open-connector.url="https://connector.example/mcp"',
      'mcp_servers.open-connector.http_headers.Authorization="Bearer connector-token"',
      'mcp_servers.open-connector.http_headers.X-Connector-Scope="workspace"'
    ])
  })

  it("keeps mapped bearer values out of argv and supplies them through the run environment", () => {
    const overrides = codexMcpOverrides([PREVIEW_BROWSER])
    expect(overrides.join(" ")).not.toContain("preview-token")
    expect(codexMcpEnvironment([PREVIEW_BROWSER])).toStrictEqual({
      JINGLER_BROWSER_MCP_AUTHORIZATION: "Bearer preview-token"
    })
    expect(overrides).toContain(
      'shell_environment_policy.filters.JINGLER_BROWSER_MCP_AUTHORIZATION="exclude"'
    )
  })
})

describe("opencodeMcpEntries", () => {
  it("renders dynamic registrations with per-server headers intact", () => {
    expect(opencodeMcpEntries([OPEN_CONNECTOR, PREVIEW_BROWSER])).toEqual([
      {
        name: "open-connector",
        config: {
          type: "remote",
          url: "https://connector.example/mcp",
          enabled: true,
          headers: {
            Authorization: "Bearer connector-token",
            "X-Connector-Scope": "workspace"
          }
        }
      },
      {
        name: "jingler-browser",
        config: {
          type: "remote",
          url: "http://127.0.0.1:32123/mcp",
          enabled: true,
          headers: { Authorization: "Bearer preview-token" }
        }
      }
    ])
  })

  it("omits empty headers and is empty for an absent collection", () => {
    expect(
      opencodeMcpEntries([
        { name: "public-tools", url: "https://public.example/mcp", headers: {} }
      ])
    ).toEqual([
      {
        name: "public-tools",
        config: {
          type: "remote",
          url: "https://public.example/mcp",
          enabled: true
        }
      }
    ])
    expect(opencodeMcpEntries(null)).toEqual([])
    expect(opencodeMcpEntries(undefined)).toEqual([])
    expect(opencodeMcpEntries([])).toEqual([])
  })

  it("keeps either available server independently", () => {
    expect(opencodeMcpEntries([PREVIEW_BROWSER])).toEqual([
      {
        name: "jingler-browser",
        config: {
          type: "remote",
          url: "http://127.0.0.1:32123/mcp",
          enabled: true,
          headers: { Authorization: "Bearer preview-token" }
        }
      }
    ])
    expect(opencodeMcpEntries([OPEN_CONNECTOR])).toEqual([
      {
        name: "open-connector",
        config: {
          type: "remote",
          url: "https://connector.example/mcp",
          enabled: true,
          headers: {
            Authorization: "Bearer connector-token",
            "X-Connector-Scope": "workspace"
          }
        }
      }
    ])
  })

  it("renders a duplicate name once and keeps its first attachment", () => {
    expect(
      opencodeMcpEntries([
        PREVIEW_BROWSER,
        {
          name: PREVIEW_BROWSER.name,
          url: "http://127.0.0.1:49999/mcp",
          headers: { Authorization: "Bearer duplicate-token" }
        }
      ])
    ).toEqual([
      {
        name: "jingler-browser",
        config: {
          type: "remote",
          url: "http://127.0.0.1:32123/mcp",
          enabled: true,
          headers: { Authorization: "Bearer preview-token" }
        }
      }
    ])
  })
})
