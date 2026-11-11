import { describe, expect, it } from "vitest"
import { checkoutForCreatedPr, createdPrFromToolOutput, worktreeForBranch } from "./created-pr.js"

const slugs = new Set(["acme/widget"])
const url = "https://github.com/Acme/Widget/pull/7\n"

describe("createdPrFromToolOutput", () => {
  it("links the URL gh pr create printed", () => {
    expect(createdPrFromToolOutput("cd ../x && gh pr create --fill", url, slugs)).toEqual({ repository: "acme/widget", number: 7 })
  })
  it("ignores gh pr list output", () => {
    expect(createdPrFromToolOutput("gh pr list", url, slugs)).toBeNull()
  })
  it("ignores another repo", () => {
    expect(createdPrFromToolOutput("gh pr create", "https://github.com/other/repo/pull/7", slugs)).toBeNull()
  })
  it("ignores output without a URL", () => {
    expect(createdPrFromToolOutput("gh pr create", "failed", slugs)).toBeNull()
  })
})

describe("checkoutForCreatedPr", () => {
  const checkouts = [
    { id: "api", slug: "acme/api", branch: "feat/x" },
    { id: "web", slug: "acme/web", branch: "feat/x" }
  ]
  const pr = { repository: "Acme/Web", author: "Me", headRefName: "feat/x" }

  it("routes the viewer's PR to the checkout with that repo and branch", () => {
    expect(checkoutForCreatedPr(pr, "me", checkouts)).toBe("web")
  })
  it("rejects another author, an unknown viewer, another branch, or another repo", () => {
    expect(checkoutForCreatedPr({ ...pr, author: "teammate" }, "me", checkouts)).toBeNull()
    expect(checkoutForCreatedPr(pr, null, checkouts)).toBeNull()
    expect(checkoutForCreatedPr({ ...pr, headRefName: "main" }, "me", checkouts)).toBeNull()
    expect(checkoutForCreatedPr({ ...pr, repository: "acme/other" }, "me", checkouts)).toBeNull()
  })
})

describe("worktreeForBranch", () => {
  const porcelain = [
    "worktree /repos/widget\nHEAD aaa\nbranch refs/heads/main",
    "worktree /wt/session\nHEAD bbb\nbranch refs/heads/fix/session",
    "worktree /wt/agent\nHEAD ccc\nbranch refs/heads/fix/agent-made",
    "worktree /wt/detached\nHEAD ddd\ndetached"
  ].join("\n\n")

  it("finds the worktree with the branch checked out", () => {
    expect(worktreeForBranch(porcelain, "fix/agent-made")).toBe("/wt/agent")
  })
  it("does not match a branch prefix or a missing branch", () => {
    expect(worktreeForBranch(porcelain, "fix/agent")).toBeNull()
    expect(worktreeForBranch(porcelain, "feat/none")).toBeNull()
  })
})
