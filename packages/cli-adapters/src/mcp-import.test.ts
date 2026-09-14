import { describe, expect, it } from "vitest"
import { parseClaudeMcp, parseCodexMcp, parseOpencodeMcp } from "./mcp-import.js"

describe("parseClaudeMcp", () => {
  it("reads stdio and remote servers from mcpServers and per-project blocks", () => {
    const candidates = parseClaudeMcp(JSON.stringify({
      mcpServers: {
        linear: {
          type: "stdio",
          command: "npx",
          args: ["-y", "mcp-remote", "https://mcp.linear.app/sse"],
          env: { LINEAR_API_KEY: "lin_secret" }
        },
        sentry: { type: "http", url: "https://mcp.sentry.dev/mcp", headers: { Authorization: "Bearer x" } }
      },
      projects: {
        "/Users/me/repo": {
          mcpServers: {
            legacy: { type: "sse", url: "https://legacy.example/sse" },
            linear: { command: "duplicate-ignored" }
          }
        }
      }
    }))
    expect(candidates).toEqual([
      {
        name: "linear",
        source: "claude",
        problem: null,
        entry: {
          type: "local",
          command: ["npx", "-y", "mcp-remote", "https://mcp.linear.app/sse"],
          environment: { LINEAR_API_KEY: "lin_secret" },
          enabled: true
        }
      },
      {
        name: "sentry",
        source: "claude",
        problem: null,
        entry: {
          type: "remote",
          url: "https://mcp.sentry.dev/mcp",
          headers: { Authorization: "Bearer x" },
          enabled: true
        }
      },
      {
        name: "legacy",
        source: "claude",
        problem: null,
        entry: {
          type: "remote",
          url: "https://legacy.example/sse",
          transport: "sse",
          headers: {},
          enabled: true
        }
      }
    ])
  })

  it("treats non-string Claude transport values as absent", () => {
    expect(parseClaudeMcp(JSON.stringify({
      mcpServers: { docs: { type: null, url: "https://example.com/mcp" } }
    }))[0]?.entry).toMatchObject({ type: "remote", url: "https://example.com/mcp" })
  })

  it("flags reserved names and unrecognised shapes instead of dropping them", () => {
    const candidates = parseClaudeMcp(JSON.stringify({
      mcpServers: {
        browser: { command: "npx" },
        weird: { neither: true }
      }
    }))
    expect(candidates).toEqual([
      expect.objectContaining({ name: "browser", entry: null, problem: expect.stringContaining("reserved") }),
      expect.objectContaining({ name: "weird", entry: null, problem: "Unrecognised server shape" })
    ])
  })
})

describe("parseCodexMcp", () => {
  it("reads stdio and remote servers, mapping bearer_token_env_var to a placeholder", () => {
    const candidates = parseCodexMcp([
      '[mcp_servers.docs]',
      'command = "npx"',
      'args = ["-y", "docs-mcp"]',
      '[mcp_servers.docs.env]',
      'DOCS_KEY = "secret"',
      '',
      '[mcp_servers.figma]',
      'url = "https://mcp.figma.com/mcp"',
      'bearer_token_env_var = "FIGMA_TOKEN"',
      'enabled = false'
    ].join("\n"))
    expect(candidates).toEqual([
      {
        name: "docs",
        source: "codex",
        problem: null,
        entry: {
          type: "local",
          command: ["npx", "-y", "docs-mcp"],
          environment: { DOCS_KEY: "secret" },
          enabled: true
        }
      },
      {
        name: "figma",
        source: "codex",
        problem: null,
        entry: {
          type: "remote",
          url: "https://mcp.figma.com/mcp",
          headers: { Authorization: "Bearer {env:FIGMA_TOKEN}" },
          enabled: false
        }
      }
    ])
  })

  it("returns nothing for a config without mcp_servers", () => {
    expect(parseCodexMcp('model = "gpt-5"')).toEqual([])
  })
})

describe("parseOpencodeMcp", () => {
  it("copies supported entry fields", () => {
    const candidates = parseOpencodeMcp(JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      mcp: {
        context7: {
          type: "remote",
          url: "https://mcp.context7.com/mcp",
          headers: { CONTEXT7_API_KEY: "{env:CONTEXT7_API_KEY}" },
          timeout: 10_000
        }
      }
    }))
    expect(candidates).toEqual([
      {
        name: "context7",
        source: "opencode",
        problem: null,
        entry: {
          type: "remote",
          url: "https://mcp.context7.com/mcp",
          headers: { CONTEXT7_API_KEY: "{env:CONTEXT7_API_KEY}" },
          timeout: 10_000,
          enabled: true
        }
      }
    ])
  })

  it("imports OAuth and rejects invalid URLs per entry", () => {
    const candidates = parseOpencodeMcp(JSON.stringify({ mcp: {
      oauth: { type: "remote", url: "https://example.com", oauth: {} },
      invalid: { type: "remote", url: "file:///tmp/mcp" },
      empty: null
    } }))
    expect(candidates.map(({ name, entry, problem }) => ({ name, entry, problem }))).toEqual([
      {
        name: "oauth",
        entry: {
          type: "remote",
          url: "https://example.com",
          auth: { type: "oauth" },
          headers: {},
          enabled: true
        },
        problem: null
      },
      { name: "invalid", entry: null, problem: "Invalid server configuration" },
      { name: "empty", entry: null, problem: "Invalid server configuration" }
    ])
  })
})
