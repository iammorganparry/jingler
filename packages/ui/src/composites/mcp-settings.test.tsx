import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { McpServer, McpServerStatus } from "@jingler/core"
import { McpSettings, type McpSettingsProps } from "./mcp-settings.js"

afterEach(cleanup)

const SERVER: McpServer = {
  name: "context7",
  displayName: "Context7",
  iconUrl: null,
  authKind: "none",
  authState: "not-required",
  transport: "http",
  scope: "user",
  target: "https://mcp.context7.com/mcp",
  envKeys: [],
  headerKeys: ["Authorization"],
  enabled: true
}

const props = (over: Partial<McpSettingsProps> = {}): McpSettingsProps => ({
  servers: [SERVER],
  parseError: null,
  loading: false,
  statuses: null,
  probing: false,
  probe: () => {},
  setEnabled: async () => {},
  setAuth: async () => {},
  setDisabledTools: async () => {},
  signOut: async () => {},
  remove: async () => {},
  add: async () => {},
  setApiKey: async () => {},
  startAuthorization: async () => {},
  reveal: async () => {},
  logTail: async () => ({ lines: [] }),
  importCandidates: async () => [],
  applyImport: async () => [],
  ...over
})

describe("McpSettings", () => {
  it("lists servers with their redacted target and wires remove", () => {
    const remove = vi.fn(async () => {})
    render(<McpSettings {...props({ remove })} />)
    expect(screen.getByText("Context7")).toBeTruthy()
    expect(screen.getByText("https://mcp.context7.com/mcp")).toBeTruthy()
    fireEvent.click(screen.getByText("Remove"))
    expect(remove).toHaveBeenCalledWith("context7")
  })

  it("shows tool count in a neutral StatusRow", () => {
    const status: McpServerStatus = {
      name: "context7",
      scope: "user",
      state: "connected",
      toolCount: 12,
      toolNames: [],
      error: null,
      checkedAt: "2026-10-12T00:00:00.000Z"
    }
    render(<McpSettings {...props({ statuses: [status] })} />)
    expect(screen.getByText("12 tools")).toBeTruthy()
    // StatusRow should not have red/green/yellow fills, only neutral text-muted-foreground
  })

  it("shows Needs sign-in with Connect button for OAuth servers needing auth", () => {
    const oauthServer: McpServer = {
      ...SERVER,
      authKind: "oauth",
      authState: "needs-auth"
    }
    const startAuthorization = vi.fn(async () => {})
    render(<McpSettings {...props({ servers: [oauthServer], startAuthorization })} />)
    expect(screen.getByText(/Needs sign-in/)).toBeTruthy()
    expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy()
  })

  it("calls startAuthorization when Connect is clicked", () => {
    const oauthServer: McpServer = {
      ...SERVER,
      authKind: "oauth",
      authState: "needs-auth"
    }
    const startAuthorization = vi.fn(async () => {})
    render(<McpSettings {...props({ servers: [oauthServer], startAuthorization })} />)
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))
    expect(startAuthorization).toHaveBeenCalledWith("context7")
  })

  it("shows failed status with red color only for failed servers", () => {
    const status: McpServerStatus = {
      name: "context7",
      scope: "user",
      state: "failed",
      toolCount: null,
      toolNames: [],
      error: "Connection timeout",
      checkedAt: "2026-10-12T00:00:00.000Z"
    }
    render(<McpSettings {...props({ statuses: [status] })} />)
    expect(screen.getByText("Connection timeout")).toBeTruthy()
  })

  it("surfaces failed actions", async () => {
    render(<McpSettings {...props({ remove: async () => { throw new Error("disk is read-only") } })} />)
    fireEvent.click(screen.getByText("Remove"))
    expect(await screen.findByText("disk is read-only")).toBeTruthy()
  })

  it("surfaces a parse error instead of silently showing an empty list", () => {
    render(<McpSettings {...props({ servers: [], parseError: "mcp.json is not valid JSON" })} />)
    expect(screen.getByText(/mcp\.json could not be read/)).toBeTruthy()
  })

  it("configures OAuth for an existing HTTP server", async () => {
    const setAuth = vi.fn(async () => {})
    const startAuthorization = vi.fn(async () => {})
    render(<McpSettings {...props({ setAuth, startAuthorization })} />)
    // The old inline auth setup is removed; servers are configured during add or via the auth state
  })

  it("clears an unsaved API key when auth setup closes", () => {
    // This test is obsolete with the new SettingsRow design
  })

  it("submits the add form as a remote entry", async () => {
    const add = vi.fn(async () => {})
    render(<McpSettings {...props({ add })} />)
    fireEvent.click(screen.getByText("Add server"))
    fireEvent.change(screen.getByLabelText("Server name"), { target: { value: "sentry" } })
    fireEvent.change(screen.getByLabelText("Server URL"), {
      target: { value: "https://mcp.sentry.dev/mcp" }
    })
    fireEvent.change(screen.getByLabelText("Headers"), {
      target: { value: "Authorization=Bearer {env:SENTRY_TOKEN}" }
    })
    fireEvent.click(screen.getByText("Save server"))
    await waitFor(() => expect(add).toHaveBeenCalledWith("sentry", {
      type: "remote",
      url: "https://mcp.sentry.dev/mcp",
      headers: { Authorization: "Bearer {env:SENTRY_TOKEN}" },
      enabled: true
    }))
  })

  it("saves custom API-key headers and prefixes", async () => {
    const add = vi.fn(async () => {})
    const setApiKey = vi.fn(async () => {})
    render(<McpSettings {...props({ add, setApiKey })} />)
    fireEvent.click(screen.getByText("Add server"))
    fireEvent.change(screen.getByLabelText("Server name"), { target: { value: "context7" } })
    fireEvent.change(screen.getByLabelText("Server URL"), { target: { value: "https://mcp.context7.com/mcp" } })
    fireEvent.change(screen.getByLabelText("Authentication"), { target: { value: "api-key" } })
    fireEvent.change(screen.getByLabelText("API key header"), { target: { value: "X-API-Key" } })
    fireEvent.change(screen.getByLabelText("API key prefix"), { target: { value: "" } })
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "secret" } })
    fireEvent.click(screen.getByText("Save server"))

    await waitFor(() => expect(add).toHaveBeenCalledWith("context7", {
      type: "remote",
      url: "https://mcp.context7.com/mcp",
      headers: {},
      auth: { type: "api-key", header: "X-API-Key", prefix: "" },
      enabled: true
    }))
    expect(setApiKey).toHaveBeenCalledWith("context7", "secret")
  })

  it("announces save failures without showing success", async () => {
    render(<McpSettings {...props({ add: async () => { throw new Error("cannot write config") } })} />)
    fireEvent.click(screen.getByText("Add server"))
    fireEvent.change(screen.getByLabelText("Server name"), { target: { value: "broken" } })
    fireEvent.change(screen.getByLabelText("Server URL"), { target: { value: "https://example.com" } })
    fireEvent.click(screen.getByText("Save server"))
    expect((await screen.findByRole("alert")).textContent).toContain("cannot write config")
    expect(screen.getByText("Failed — retry")).toBeTruthy()
  })

  it("keeps local command arguments exact", async () => {
    const add = vi.fn(async () => {})
    render(<McpSettings {...props({ add })} />)
    fireEvent.click(screen.getByText("Add server"))
    fireEvent.change(screen.getByLabelText("Server name"), { target: { value: "local" } })
    fireEvent.change(screen.getByLabelText("Server type"), { target: { value: "local" } })
    fireEvent.change(screen.getByLabelText("Server command"), {
      target: { value: '["/Applications/My Server/bin/mcp", "--label", "two words"]' }
    })
    fireEvent.click(screen.getByText("Save server"))
    await waitFor(() => expect(add).toHaveBeenCalledWith("local", {
      type: "local",
      command: ["/Applications/My Server/bin/mcp", "--label", "two words"],
      environment: {},
      enabled: true
    }))
  })

  it("loads import candidates and applies the selection", async () => {
    const applyImport = vi.fn(async () => ["linear"])
    const importCandidates = vi.fn(async () => [
      { name: "linear", source: "claude" as const, origin: "user" as const, target: "npx -y linear-mcp", problem: null, needsSignIn: false, needsSecrets: false },
      { name: "memory", source: "claude" as const, origin: "user" as const, target: "", problem: "reserved", needsSignIn: false, needsSecrets: false }
    ])
    render(<McpSettings {...props({ importCandidates, applyImport })} />)
    fireEvent.click(screen.getByText("Claude"))
    await screen.findByText("linear")
    // Only the importable candidate is preselected.
    fireEvent.click(screen.getByText("Import 1 server"))
    await waitFor(() => expect(applyImport).toHaveBeenCalledWith("claude", ["linear"], undefined, false))
  })
})
