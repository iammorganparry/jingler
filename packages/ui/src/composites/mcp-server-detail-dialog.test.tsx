import type { McpServer } from "@jingler/core"
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
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
  it("renders the log tail and the reported tool count", () => {
    render(
      <McpServerDetailDialog
        server={SERVER}
        open
        onOpenChange={() => {}}
        toolCount={6}
        logLines={["[info] connected"]}
        logLoading={false}
        oauthAccount="morgan@trigify.io"
      />
    )
    expect(screen.getByText("[info] connected")).toBeTruthy()
    expect(screen.getByText("6 tools available")).toBeTruthy()
  })

  it("shows the OAuth row only when an account is authenticated", () => {
    const { rerender } = render(
      <McpServerDetailDialog
        server={SERVER}
        open
        onOpenChange={() => {}}
        toolCount={null}
        logLines={[]}
        logLoading={false}
        oauthAccount="morgan@trigify.io"
      />
    )
    expect(screen.getByText(/Signed in as morgan@trigify.io/)).toBeTruthy()

    rerender(
      <McpServerDetailDialog
        server={SERVER}
        open
        onOpenChange={() => {}}
        toolCount={null}
        logLines={[]}
        logLoading={false}
        oauthAccount={null}
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
        toolCount={null}
        logLines={[]}
        logLoading
        oauthAccount={null}
      />
    )
    expect(screen.getByText("Loading…")).toBeTruthy()
  })
})
