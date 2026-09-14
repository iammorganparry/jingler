import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { McpServer } from "@jingler/core"
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
  remove: async () => {},
  add: async () => {},
  setApiKey: async () => {},
  startAuthorization: async () => {},
  reveal: async () => {},
  importCandidates: async () => [],
  applyImport: async () => [],
  ...over
})

describe("McpSettings", () => {
  it("lists servers with their redacted target and wires remove", () => {
    const remove = vi.fn(async () => {})
    render(<McpSettings {...props({ remove })} />)
    expect(screen.getByText("context7")).toBeTruthy()
    expect(screen.getByText("https://mcp.context7.com/mcp")).toBeTruthy()
    fireEvent.click(screen.getByText("Remove"))
    expect(remove).toHaveBeenCalledWith("context7")
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
      { name: "linear", source: "claude" as const, target: "npx -y linear-mcp", problem: null },
      { name: "memory", source: "claude" as const, target: "", problem: "reserved" }
    ])
    render(<McpSettings {...props({ importCandidates, applyImport })} />)
    fireEvent.click(screen.getByText("Claude"))
    await screen.findByText("linear")
    // Only the importable candidate is preselected.
    fireEvent.click(screen.getByText("Import 1 server"))
    await waitFor(() => expect(applyImport).toHaveBeenCalledWith("claude", ["linear"]))
  })
})
