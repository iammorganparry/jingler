import type { McpServer } from "@jingler/core"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { McpServerDetailDialog } from "./mcp-server-detail-dialog.js"

afterEach(cleanup)

const SERVER: McpServer = {
  name: "runpod",
  displayName: "RunPod",
  iconUrl: null,
  authKind: "oauth",
  authState: "ready",
  transport: "http",
  scope: "user",
  target: "https://runpod.example/mcp",
  envKeys: [],
  headerKeys: [],
  enabled: true
}

describe("McpServerDetailDialog", () => {
  it("renders the log tail and tool toggles, and reports toggle changes", () => {
    const onToggleTool = vi.fn()
    render(
      <McpServerDetailDialog
        server={SERVER}
        open
        onOpenChange={() => {}}
        tools={[{ name: "search", enabled: true }, { name: "deploy", enabled: false }]}
        onToggleTool={onToggleTool}
        logLines={["[info] connected"]}
        logLoading={false}
        oauthAccount="morgan@trigify.io"
        onSignOut={() => {}}
      />
    )
    expect(screen.getByText("[info] connected")).toBeTruthy()
    expect(screen.getByText("search")).toBeTruthy()
    fireEvent.click(screen.getByLabelText("Enable tool search"))
    expect(onToggleTool).toHaveBeenCalledWith("search", false)
  })

  it("shows the OAuth row with sign-out only when an account is authenticated", () => {
    const onSignOut = vi.fn()
    const { rerender } = render(
      <McpServerDetailDialog
        server={SERVER}
        open
        onOpenChange={() => {}}
        tools={[]}
        onToggleTool={() => {}}
        logLines={[]}
        logLoading={false}
        oauthAccount="morgan@trigify.io"
        onSignOut={onSignOut}
      />
    )
    expect(screen.getByText(/Signed in as morgan@trigify.io/)).toBeTruthy()
    fireEvent.click(screen.getByText("Sign out"))
    expect(onSignOut).toHaveBeenCalled()

    rerender(
      <McpServerDetailDialog
        server={SERVER}
        open
        onOpenChange={() => {}}
        tools={[]}
        onToggleTool={() => {}}
        logLines={[]}
        logLoading={false}
        oauthAccount={null}
        onSignOut={onSignOut}
      />
    )
    expect(screen.queryByText(/Signed in as/)).toBeNull()
  })

  it("shows a loading placeholder while the log tail is refreshing", () => {
    render(
      <McpServerDetailDialog
        server={SERVER}
        open
        onOpenChange={() => {}}
        tools={[]}
        onToggleTool={() => {}}
        logLines={[]}
        logLoading
        oauthAccount={null}
        onSignOut={() => {}}
      />
    )
    expect(screen.getByText("Loading…")).toBeTruthy()
  })
})
