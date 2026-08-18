import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { testSession } from "../test-support.js"
import { SessionRow } from "./session-row.js"

afterEach(cleanup)

const LINEAR_ISSUE_TRIGGER = /Select linked Linear issue/
const SECOND_LINEAR_ISSUE = /ENG-124 Show every linked task/

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

describe("SessionRow multi-issue selector", () => {
  it("uses the Linear mark and selects among multiple linked issues", () => {
    const onIssueSelect = vi.fn()
    render(
      <SessionRow
        session={testSession({
          id: "linear-multiple",
          linkedIssues: [
            {
              providerId: "linear",
              id: "issue-1",
              identifier: "ENG-123",
              url: "https://linear.app/acme/issue/ENG-123",
              title: "Provider-neutral badges",
              labels: []
            },
            {
              providerId: "linear",
              id: "issue-2",
              identifier: "ENG-124",
              url: "https://linear.app/acme/issue/ENG-124",
              title: "Show every linked task",
              labels: []
            }
          ],
          selectedIssue: { providerId: "linear", id: "issue-1" }
        })}
        onIssueSelect={onIssueSelect}
      />
    )

    const trigger = screen.getByRole("button", { name: LINEAR_ISSUE_TRIGGER })
    expect(trigger.querySelector('[data-linear-mark="true"]')).not.toBeNull()
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole("option", { name: SECOND_LINEAR_ISSUE }))
    expect(onIssueSelect).toHaveBeenCalledWith("linear-multiple", {
      providerId: "linear",
      id: "issue-2"
    })
  })
})
