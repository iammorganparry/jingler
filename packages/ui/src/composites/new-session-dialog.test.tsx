import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import type { Environment } from "@jingler/core"
import type { NewSessionDialogProps } from "./new-session-dialog.js"
import { NewSessionDialog } from "./new-session-dialog.js"

beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.setPointerCapture = () => undefined
  Element.prototype.releasePointerCapture = () => undefined
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
})
afterEach(cleanup)
afterAll(() => vi.unstubAllGlobals())

const props: NewSessionDialogProps = {
  open: true,
  onClose: () => {},
  repos: [
    {
      name: "widget",
      path: "/repos/widget",
      defaultBranch: "main",
      currentBranch: "main",
      remoteUrl: null,
      githubSlug: null
    }
  ],
  clis: [
    {
      kind: "claude",
      label: "Claude Code",
      binPath: "/usr/bin/claude",
      version: "1.0.0",
      available: true
    }
  ],
  loadBranches: async () => ["main"],
  onCreate: async () => {}
}

const ownedMachine: Environment = {
  id: "device-buildbox",
  name: "buildbox",
  platform: { os: "linux", arch: "x64" },
  capabilities: {
    version: 1,
    capabilities: ["session.start"],
    harnesses: ["codex"],
    maxConcurrentSessions: 2
  },
  state: "online",
  agentVersion: "2.0.3",
  lastSeenAt: 1
}

describe("NewSessionDialog environments", () => {
  it("shows Local and automatically discovered owned machines", () => {
    render(<NewSessionDialog {...props} environments={[ownedMachine]} />)
    expect(
      screen.getByRole("combobox", { name: "Execution environment" })
        .textContent
    ).toContain("Local")
    expect(screen.getByText(/buildbox.*uses codex/i, { selector: "option" }))
      .toBeTruthy()
  })

  it("does not render sharing code pairing link or relay URL controls", () => {
    render(<NewSessionDialog {...props} environments={[ownedMachine]} />)
    expect(screen.queryByLabelText(/sharing code/i)).toBeNull()
    expect(screen.queryByLabelText(/pairing link/i)).toBeNull()
    expect(screen.queryByLabelText(/relay url/i)).toBeNull()
  })

  it("selects an online device and switches to its preferred supported harness", async () => {
    render(
      <NewSessionDialog
        {...props}
        environments={[ownedMachine]}
        clis={[
          ...props.clis,
          {
            kind: "codex",
            label: "Codex",
            binPath: "/usr/bin/codex",
            version: "1.0.0",
            available: true
          }
        ]}
        loadEnvironmentDiscovery={async () => ({
          version: 1,
          deviceId: ownedMachine.id,
          discovery: {
            version: 1,
            agentVersion: "2.0.3",
            platform: ownedMachine.platform,
            capabilities: {
              version: 1 as const,
              capabilities: ["session.start"] as const,
              harnesses: ["codex"] as const,
              maxConcurrentSessions: 2
            },
            repositories: props.repos.map((repo) => ({
              ...repo,
              branches: [repo.defaultBranch ?? "main"]
            }))
          },
          updatedAt: 1
        })}
      />
    )
    fireEvent.change(document.querySelector("select")!, {
      target: { value: ownedMachine.id }
    })
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Execution environment" })
          .textContent
      ).toContain("buildbox")
    )
    expect(screen.getByText("Codex")).toBeTruthy()
  })

  it("explains which harness an owned machine will use", () => {
    render(<NewSessionDialog {...props} environments={[ownedMachine]} />)
    expect(screen.getByText(/buildbox.*uses codex/i, { selector: "option" }))
      .toBeTruthy()
  })
})

describe("NewSessionDialog workspace choice", () => {
  it("labels the default-on toggle and explains both workspace modes", () => {
    render(<NewSessionDialog {...props} />)

    const toggle = screen.getByRole("switch", {
      name: "Use isolated worktree"
    })
    expect(toggle.getAttribute("aria-checked")).toBe("true")
    expect(
      screen.getByText("Creates an isolated fork of this branch for the session.")
    ).toBeDefined()

    fireEvent.click(toggle)
    expect(toggle.getAttribute("aria-checked")).toBe("false")
    expect(
      screen.getByText(
        "The agent shares this repository checkout and works directly on the selected branch."
      )
    ).toBeDefined()
  })

  it("turns worktree creation back on when the dialog reopens", () => {
    const view = render(<NewSessionDialog {...props} />)
    const toggle = screen.getByRole("switch", {
      name: "Use isolated worktree"
    })
    fireEvent.click(toggle)
    expect(toggle.getAttribute("aria-checked")).toBe("false")

    view.rerender(<NewSessionDialog {...props} open={false} />)
    view.rerender(<NewSessionDialog {...props} open />)
    expect(
      screen
        .getByRole("switch", { name: "Use isolated worktree" })
        .getAttribute("aria-checked")
    ).toBe("true")
  })
})

describe("NewSessionDialog issue providers", () => {
  it("selects Linear as the issue source", async () => {
    const loadProviderIssues = vi.fn(async () => [])
    render(
      <NewSessionDialog
        {...props}
        issueProviders={[{ pluginId: "linear", id: "linear", label: "Linear" }]}
        loadProviderIssues={loadProviderIssues}
        onCreateFromIssue={async () => {}}
      />
    )

    fireEvent.click(screen.getByText("From issue"))

    await waitFor(() => expect(loadProviderIssues).toHaveBeenCalledWith(
      "linear",
      "/repos/widget",
      { mine: false, search: "" }
    ))
  })

  it("shows an actionable configuration error for an unconfigured provider", async () => {
    render(
      <NewSessionDialog
        {...props}
        issueProviders={[{ pluginId: "linear", id: "linear", label: "Linear" }]}
        loadProviderIssues={async () => {
          throw new Error("Configure the Linear API key in Settings → Plugins.")
        }}
        onCreateFromIssue={async () => {}}
      />
    )

    fireEvent.click(screen.getByText("From issue"))
    expect(await screen.findByText(/Configure the Linear API key/)).toBeDefined()
  })
})
