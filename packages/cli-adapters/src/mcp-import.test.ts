import { describe, expect, it } from "vitest"
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  claudeConnectorSettings,
  preferClaudeConnectors,
  dedupeCandidates,
  discoverClaudeConnectors,
  parseClaudeMcpRows,
  managedMcpPaths,
  readClaudeFileServers,
  parseClaudeMcp,
  parseClaudeMcpList,
  parseCodexMcp,
  parseOpencodeMcp
} from "./mcp-import.js"

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

describe("Claude settings.json and managed-mcp.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-files-"))
  const settings = join(dir, "settings.json")
  const managed = join(dir, "managed-mcp.json")
  writeFileSync(settings, JSON.stringify({
    permissions: {},
    mcpServers: {
      "clive-memory": { command: "node", args: ["memory.js"] },
      shared: { type: "http", url: "https://settings.example/mcp" }
    }
  }))
  writeFileSync(managed, JSON.stringify({
    mcpServers: {
      shared: { type: "http", url: "https://managed.example/mcp" },
      corp: { type: "http", url: "https://corp.example/mcp" }
    }
  }))

  it("labels candidates with the origin and keeps stdio servers", () => {
    const [stdio] = parseClaudeMcp(readFileSync(settings, "utf8"), "user-settings")
    expect(stdio).toMatchObject({
      name: "clive-memory",
      origin: "user-settings",
      entry: { type: "local", command: ["node", "memory.js"] }
    })
  })

  it("lists each server once across files, first file winning, and skips missing files", async () => {
    const found = await readClaudeFileServers([
      { path: settings, origin: "user-settings" },
      { path: join(dir, "absent.json"), origin: "managed" },
      { path: managed, origin: "managed" }
    ])
    expect(found.map((c) => [c.name, c.origin])).toEqual([
      ["clive-memory", "user-settings"],
      ["shared", "user-settings"],
      ["corp", "managed"]
    ])
  })

  it("skips malformed files and lets ~/.claude.json entries win over extras", async () => {
    const broken = join(dir, "broken.json")
    writeFileSync(broken, "{nope")
    expect(await readClaudeFileServers([{ path: broken, origin: "managed" }])).toEqual([])
    const main = parseClaudeMcp(JSON.stringify({ mcpServers: { shared: { command: "main" } } }))
    const merged = dedupeCandidates(main, await readClaudeFileServers([{ path: settings, origin: "user-settings" }]))
    expect(merged.find((c) => c.name === "shared")?.origin).toBeUndefined()
  })

  it("knows the managed-mcp.json path per OS", () => {
    expect(managedMcpPaths("darwin")).toEqual(["/Library/Application Support/ClaudeCode/managed-mcp.json"])
    expect(managedMcpPaths("linux")).toEqual(["/etc/claude-code/managed-mcp.json"])
    expect(managedMcpPaths("win32")[0]).toBe("C:\\Program Files\\ClaudeCode\\managed-mcp.json")
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
      oauth: {
        type: "remote",
        url: "https://example.com",
        oauth: { clientId: "client", clientSecret: "{env:SECRET}", scope: "tools:read" }
      },
      noOauth: { type: "remote", url: "https://api.example.com", oauth: false },
      invalid: { type: "remote", url: "file:///tmp/mcp" },
      empty: null
    } }))
    expect(candidates.map(({ name, entry, problem }) => ({ name, entry, problem }))).toEqual([
      {
        name: "oauth",
        entry: {
          type: "remote",
          url: "https://example.com",
          auth: {
            type: "oauth",
            clientId: "client",
            clientSecret: "{env:SECRET}",
            scope: "tools:read"
          },
          headers: {},
          enabled: true
        },
        problem: null
      },
      {
        name: "noOauth",
        entry: {
          type: "remote",
          url: "https://api.example.com",
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

const LISTING = [
  "Checking MCP server health…",
  "",
  "obsidian: npx @mauricio.wolff/mcp-obsidian@latest /docs - ✓ Connected",
  "claude.ai Linear: https://mcp.linear.app/mcp - ! Needs authentication",
  "claude.ai Supabase - GTM Grid: https://mcp.supabase.com/mcp - ✓ Connected",
  "plugin:engineering:notion: https://mcp.notion.com/mcp (HTTP) - ! Needs authentication",
  "plugin:engineering:legacy: https://legacy.example/sse (SSE) - ✓ Connected",
  "plugin:engineering:placeholder:  (HTTP) - - Not configured",
  "plugin:engineering:local: node server.js - ✓ Connected",
  "claude.ai Browser: https://mcp.browser.example/mcp - ✓ Connected"
].join("\n")

describe("parseClaudeMcpList", () => {
  it("parses claude.ai and plugin servers into OAuth remote candidates with origins", () => {
    const candidates = parseClaudeMcpList(LISTING)
    expect(candidates.map(({ name, origin }) => [name, origin])).toEqual([
      ["claude-ai-linear", "claude.ai"],
      ["claude-ai-supabase-gtm-grid", "claude.ai"],
      ["plugin-engineering-notion", "plugin"],
      ["plugin-engineering-legacy", "plugin"],
      ["plugin-engineering-placeholder", "plugin"],
      ["plugin-engineering-local", "plugin"],
      ["claude-ai-browser", "claude.ai"]
    ])
    expect(candidates[0]).toMatchObject({
      name: "claude-ai-linear",
      origin: "claude.ai",
      entry: null,
      problem: expect.stringContaining("natively")
    })
    expect(candidates.find(({ name }) => name === "plugin-engineering-notion")).toMatchObject({
      problem: null,
      entry: { type: "remote", url: "https://mcp.notion.com/mcp", auth: { type: "oauth" } }
    })
  })

  it("carries a problem for not-configured, SSE and stdio entries", () => {
    const byName = Object.fromEntries(parseClaudeMcpList(LISTING).map((c) => [c.name, c]))
    expect(byName["plugin-engineering-placeholder"]).toMatchObject({ entry: null, problem: expect.stringContaining("Not configured") })
    expect(byName["plugin-engineering-legacy"]).toMatchObject({ entry: null, problem: expect.stringContaining("SSE") })
    expect(byName["plugin-engineering-local"]).toMatchObject({ entry: null, problem: expect.stringContaining("stdio") })
  })

  it("never overwrites existing names and flags in-listing collisions", () => {
    const candidates = parseClaudeMcpList(
      "plugin:eng:linear: https://a.example/mcp (HTTP) - ✓ Connected\nplugin:eng:Linear: https://b.example/mcp (HTTP) - ✓ Connected",
      new Set(["plugin-eng-linear"])
    )
    expect(candidates).toHaveLength(2)
    for (const candidate of candidates) {
      expect(candidate).toMatchObject({ entry: null, problem: expect.stringContaining("already exists") })
    }
  })
})

describe("claudeConnectorSettings", () => {
  const rows = parseClaudeMcpRows([
    "Checking MCP server health…",
    "claude.ai Linear: https://mcp.linear.app/mcp - ! Needs authentication",
    "claude.ai Supabase - GTM Grid: https://mcp.supabase.com/mcp?project_ref=x - ✔ Connected",
    "plugin:eng:notion: https://mcp.notion.com/mcp (HTTP) - ! Needs authentication",
    "obsidian: npx obsidian-mcp - ✔ Connected"
  ].join("\n"))

  it("parses every row with its CLI name and state", () => {
    expect(rows.map(({ name, state }) => [name, state])).toEqual([
      ["claude.ai Linear", "needs-auth"],
      ["claude.ai Supabase - GTM Grid", "connected"],
      ["plugin:eng:notion", "needs-auth"],
      ["obsidian", "connected"]
    ])
  })

  it("denies every non-connector and connectors already in mcp.json", () => {
    const settings = JSON.parse(claudeConnectorSettings(rows, ["https://mcp.linear.app/mcp/"])!)
    expect(settings.disableAllHooks).toBe(true)
    expect(settings.deniedMcpServers.map(({ serverName }: { serverName: string }) => serverName)).toEqual([
      "claude.ai Linear",
      "plugin:eng:notion",
      "obsidian"
    ])
    expect(settings.allowedMcpServers).toBeUndefined()
  })

  it("denies connectors turned off for this chat", () => {
    const settings = JSON.parse(claudeConnectorSettings(rows, [], ["claude.ai Linear"])!)
    expect(settings.deniedMcpServers.map(({ serverName }: { serverName: string }) => serverName)).toContain("claude.ai Linear")
    expect(claudeConnectorSettings(rows, [], ["claude.ai Linear", "claude.ai Supabase - GTM Grid"])).toBeNull()
  })

  it("is null when no connector is left to load", () => {
    expect(claudeConnectorSettings(rows.filter(({ name }) => !name.startsWith("claude.ai")), [])).toBeNull()
    expect(claudeConnectorSettings(rows, ["https://mcp.linear.app/mcp", "https://mcp.supabase.com/mcp?project_ref=x"])).toBeNull()
  })
})

describe("discoverClaudeConnectors", () => {
  const fakeCli = (body: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "fake-claude-"))
    const file = join(dir, "claude")
    writeFileSync(file, `#!/bin/sh\n${body}\n`)
    chmodSync(file, 0o755)
    return file
  }
  const options = { cwd: tmpdir(), taken: new Set<string>() }

  it("returns an explanatory problem when the binary is missing", async () => {
    const result = await discoverClaudeConnectors({ ...options, binary: "/nonexistent/claude" })
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ entry: null, problem: expect.stringContaining("not found") })
  })

  it("explains a signed-out CLI instead of crashing", async () => {
    const binary = fakeCli(
      'if [ "$1" = auth ]; then echo \'{"loggedIn":false}\'; else echo "Checking MCP server health…"; fi'
    )
    const result = await discoverClaudeConnectors({ ...options, binary })
    expect(result).toEqual([expect.objectContaining({ entry: null, problem: expect.stringContaining("signed out") })])
  })

  it("lists connectors from a logged-in CLI", async () => {
    const binary = fakeCli(
      'if [ "$1" = auth ]; then echo \'{"loggedIn":true,"authMethod":"claude.ai"}\'; else echo "claude.ai Linear: https://mcp.linear.app/mcp - ! Needs authentication"; fi'
    )
    const result = await discoverClaudeConnectors({ ...options, binary })
    expect(result).toEqual([expect.objectContaining({ name: "claude-ai-linear", entry: null, problem: expect.stringContaining("natively") })])
  })

  it("reports a failing listing as a problem", async () => {
    const binary = fakeCli("exit 1")
    const result = await discoverClaudeConnectors({ ...options, binary })
    expect(result).toEqual([expect.objectContaining({ entry: null, problem: expect.stringContaining("failed") })])
  })
})

describe("preferClaudeConnectors", () => {
  const rows = parseClaudeMcpRows("claude.ai Slack: https://mcp.slack.com/mcp - ✔ Connected")
  const remote = (name: string, url: string, needsAuth?: true) => ({ name, url, headers: {}, ...(needsAuth ? { needsAuth } : {}) })

  it("drops a tokenless copy of a claude.ai connector and keeps signed-in or unrelated servers", () => {
    const servers = [
      remote("slack", "https://mcp.slack.com/mcp/", true),
      remote("slack-signed-in", "https://mcp.slack.com/mcp"),
      remote("sentry", "https://mcp.sentry.dev/mcp", true)
    ]
    expect(preferClaudeConnectors(servers, rows).map((server) => server.name)).toEqual(["slack-signed-in", "sentry"])
  })
})
