import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { testSession } from "../test-support.js"
import { SessionRow } from "./session-row.js"

afterEach(cleanup)

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
