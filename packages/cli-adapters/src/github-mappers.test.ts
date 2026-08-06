import { describe, expect, it } from "vitest"
import {
  checkStatusOf,
  isGitHubAccessWebhook,
  mapCheck,
  mapPrView,
  mapReviewThreads,
  postableLines,
  rollupChecks,
  unifiedDiffFromApiFiles
} from "./github-mappers.js"

describe("GitHub response mappers", () => {
  it("combines REST reviews, comments, checks, requested reviewers, and merge blockers", () => {
    const pull = mapPrView({
      number: 14,
      state: "open",
      draft: false,
      title: "Safer auth",
      html_url: "https://github.com/acme/widget/pull/14",
      user: { login: "octocat", avatar_url: "https://avatars.test/octocat" },
      head: { ref: "feature/auth" },
      base: { ref: "main" },
      mergeable: false,
      reviews: [
        {
          id: 1,
          state: "CHANGES_REQUESTED",
          body: "Fix the race",
          submitted_at: "2026-01-01T10:00:00Z",
          user: { login: "reviewer" }
        }
      ],
      requested_reviewers: [{ login: "second-reviewer" }],
      comments: [
        {
          id: 2,
          body: "Context",
          created_at: "2026-01-01T09:00:00Z",
          user: { login: "maintainer" }
        }
      ],
      checks: [
        { name: "build", status: "completed", conclusion: "failure" },
        { context: "lint", state: "success" }
      ]
    })

    expect(pull.reviewers).toEqual([
      { login: "reviewer", state: "changes_requested" },
      { login: "second-reviewer", state: "pending" }
    ])
    expect(pull.timeline.map((item) => item.author)).toEqual(["maintainer", "reviewer"])
    expect(pull.checks.map((check) => check.status)).toEqual(["fail", "pass"])
    expect(pull.mergeBlockers).toEqual([
      "Merge conflicts",
      "1 failing check",
      "1 change request"
    ])
  })

  it("maps inline GraphQL review threads defensively", () => {
    const threads = mapReviewThreads({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  id: "THREAD_1",
                  path: "src/auth.ts",
                  line: 18,
                  startLine: 16,
                  isResolved: true,
                  resolvedBy: { login: "maintainer" },
                  comments: {
                    nodes: [
                      {
                        id: "COMMENT_1",
                        databaseId: 44,
                        body: "This can race",
                        diffHunk: "@@ -14,3 +14,5 @@",
                        authorAssociation: "MEMBER",
                        author: { login: "reviewer", __typename: "User" },
                        pullRequestReview: { id: "REVIEW_1" },
                        reactionGroups: [{ content: "THUMBS_UP", reactors: { totalCount: 2 } }]
                      }
                    ]
                  }
                }
              ]
            }
          }
        }
      }
    })

    expect(threads).toEqual([
      expect.objectContaining({
        id: "THREAD_1",
        reviewId: "REVIEW_1",
        path: "src/auth.ts",
        line: 18,
        startLine: 16,
        isResolved: true,
        resolvedBy: "maintainer",
        comments: [
          expect.objectContaining({
            id: "COMMENT_1",
            databaseId: 44,
            author: "reviewer",
            association: "MEMBER",
            reactions: [{ content: "THUMBS_UP", count: 2 }]
          })
        ]
      })
    ])
  })

  it("normalizes check states and their rollup", () => {
    expect(checkStatusOf({ status: "in_progress" })).toBe("running")
    expect(checkStatusOf({ conclusion: "cancelled" })).toBe("fail")
    expect(checkStatusOf({ state: "success" })).toBe("pass")
    expect(rollupChecks([{ status: "pass" }, { status: "pending" }])).toBe("pending")
  })

  it("preserves checks that were already normalized by the API client", () => {
    expect(
      mapCheck({ name: "build", status: "pass", detailsUrl: "https://ci/build", durationMs: 48_000 })
    ).toEqual({
      name: "build",
      status: "pass",
      detailsUrl: "https://ci/build",
      durationMs: 48_000
    })
  })
})

describe("diff and webhook defenses", () => {
  it("reconstructs patches and identifies every valid new-side anchor", () => {
    const diff = unifiedDiffFromApiFiles([
      {
        filename: "src/new.ts",
        previous_filename: "src/old.ts",
        patch: "@@ -1,2 +1,3 @@\n one\n-two\n+two updated\n+three"
      }
    ])
    expect(diff).toContain("diff --git a/src/old.ts b/src/new.ts")
    expect([...postableLines(diff).get("src/new.ts")!]).toEqual([1, 2, 3])
  })

  it("keeps added, removed, and patchless files visible in a fallback diff", () => {
    const diff = unifiedDiffFromApiFiles([
      { filename: "src/added.ts", status: "added", patch: "@@ -0,0 +1 @@\n+new" },
      { filename: "src/removed.ts", status: "removed", patch: "@@ -1 +0,0 @@\n-old" },
      { filename: "assets/binary.png", status: "modified" }
    ])
    expect(diff).toContain("--- /dev/null\n+++ b/src/added.ts")
    expect(diff).toContain("--- a/src/removed.ts\n+++ /dev/null")
    expect(diff).toContain("diff --git a/assets/binary.png b/assets/binary.png")
  })

  it("accepts only installation access-change webhook names", () => {
    expect(isGitHubAccessWebhook("installation.suspend")).toBe(true)
    expect(isGitHubAccessWebhook("installation_repositories.removed")).toBe(true)
    expect(isGitHubAccessWebhook("pull_request.opened")).toBe(false)
    expect(isGitHubAccessWebhook("not-a-webhook")).toBe(false)
  })
})
