import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { testSession } from "../test-support.js"
import { SessionRow } from "./session-row.js"

afterEach(cleanup)

describe("SessionRow interrupted status", () => {
  it("labels an interrupted session and yields to live activity", () => {
    const session = testSession({ id: "interrupted" })
    const { rerender } = render(<SessionRow session={session} interrupted />)
    expect(screen.getByText(/^Interrupted/)).toBeDefined()
    rerender(
      <SessionRow
        session={session}
        interrupted
        activity={{ kind: "running", verb: "Running", target: "pnpm test" }}
      />
    )
    expect(screen.queryByText(/^Interrupted/)).toBeNull()
  })
})

describe("SessionRow linked issue badge", () => {
  it("does not present the base branch as the live branch while semantic naming is pending", () => {
    render(
      <SessionRow
        session={testSession({
          id: "pending-branch",
          branch: "main",
          semanticBranchPending: true
        })}
      />
    )

    expect(screen.getByText("Naming branch…")).toBeDefined()
    expect(screen.queryByText("main")).toBeNull()
  })

  it("preserves the historical GitHub number as a #identifier", () => {
    render(
      <SessionRow
        session={testSession({
          id: "legacy-github",
          issueNumber: 128,
          issueTitle: "Preserve old sessions",
          issueUrl: "https://github.com/acme/widget/issues/128"
        })}
      />
    )

    expect(screen.getByLabelText("Linked issue #128").textContent).toBe("#128")
  })

  it("renders an opaque provider identifier without adding a # prefix", () => {
    render(
      <SessionRow
        session={testSession({
          id: "linear-linked",
          linkedIssue: {
            providerId: "linear",
            id: "opaque-linear-id",
            identifier: "ENG-123",
            url: "https://linear.app/acme/issue/ENG-123",
            title: "Provider-neutral badges",
            labels: []
          }
        })}
      />
    )

    const badge = screen.getByLabelText("Linked issue ENG-123")
    expect(badge.textContent).toBe("ENG-123")
    expect(badge.getAttribute("title")).toBe("ENG-123: Provider-neutral badges")
  })
})

describe("SessionRow metadata line (no wrapping)", () => {
  const longBranch = "feat/a-very-long-branch-name-that-must-truncate-instead-of-pushing-the-row-wide"

  it("keeps the PR number and diff stat on one line and only truncates the branch", () => {
    render(
      <SessionRow
        session={testSession({
          id: "nowrap",
          branch: longBranch,
          prNumber: 482,
          diff: { added: 1204, removed: 311 }
        })}
      />
    )

    const branch = screen.getByText(longBranch)
    expect(branch.className).toContain("truncate")
    expect(branch.className).toContain("min-w-0")
    expect(branch.parentElement?.className).toContain("min-w-0")

    const pr = screen.getByTitle("Pull request #482")
    expect(pr.className).toContain("shrink-0")
    expect(pr.className).toContain("whitespace-nowrap")

    const stat = screen.getByText("+1204").parentElement as HTMLElement
    expect(stat.className).toContain("shrink-0")
    expect(stat.className).toContain("whitespace-nowrap")
  })

  it("shows the stack glyph with its layer count when the session has several PRs", () => {
    render(
      <SessionRow
        session={testSession({ id: "stack", prNumber: 482, prs: [{ number: 480 }, { number: 481 }, { number: 482 }] })}
        prState={{ state: "open", checks: "fail" }}
      />
    )
    const glyph = screen.getByTestId("pr-glyph-stack")
    expect(glyph.textContent).toContain("3")
    expect(glyph.dataset.checks).toBe("fail")
  })

  it("never lets the status word wrap or shrink", () => {
    render(<SessionRow session={testSession({ id: "status", status: "idle" })} />)

    const status = screen.getByTitle("Idle")
    expect(status.className).toContain("shrink-0")
    expect(status.className).toContain("whitespace-nowrap")
  })
})

describe("SessionRow multi-repo count", () => {
  const checkout = (id: string, repo: string) => ({ id, repo, branch: "b", prNumber: null })

  it("shows `· N repos` only when the session has more than one checkout", () => {
    const multi = testSession({
      id: "multi",
      checkouts: [checkout("primary", "org/api"), checkout("c2", "org/web")],
      activeCheckoutId: "primary"
    })
    render(<SessionRow session={multi} />)
    expect(screen.getByTestId("session-repos-multi").textContent).toBe(" · 2 repos")
  })

  it("renders a legacy session exactly as before", () => {
    render(<SessionRow session={testSession({ id: "legacy" })} />)
    expect(screen.queryByTestId("session-repos-legacy")).toBeNull()
  })
})

describe("SessionRow per-checkout PRs", () => {
  const co = (id: string, repo: string, prNumber: number) => ({ id, repo, branch: "b", prNumber })

  it("labels every checkout's PR with its repo", () => {
    const session = testSession({
      id: "two-prs",
      prNumber: 1,
      checkouts: [co("web", "qa-web", 1), co("api", "qa-api", 2)],
      activeCheckoutId: "web",
      prs: [
        { number: 2, repo: "qa-api" },
        { number: 1, repo: "qa-web" }
      ]
    })
    render(<SessionRow session={session} />)
    expect(screen.getByText("qa-api #2 · qa-web #1")).toBeDefined()
  })
})
