import { describe, expect, it } from "vitest"
import {
  checkStatusOf,
  dedupeChecks,
  isGitHubAccessWebhook,
  mapCheck,
  mapPrCommit,
  mapPrView,
  mapPullRequestListItem,
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

  it("prefers browser URLs, preserves decisive reviews, and reads REST merge state", () => {
    const pull = mapPrView({
      number: 14,
      state: "open",
      title: "Safer auth",
      url: "https://api.github.com/repos/acme/widget/pulls/14",
      html_url: "https://github.com/acme/widget/pull/14",
      mergeable: true,
      mergeable_state: "behind",
      reviews: [
        { id: 1, state: "APPROVED", user: { login: "reviewer" } },
        { id: 2, state: "COMMENTED", body: "One note", user: { login: "reviewer" } }
      ]
    })
    expect(pull.url).toBe("https://github.com/acme/widget/pull/14")
    expect(pull.mergeStateStatus).toBe("BEHIND")
    expect(pull.reviewers).toEqual([{ login: "reviewer", state: "approved" }])
  })

  it("maps global inbox relationships against the connected viewer", () => {
    expect(mapPullRequestListItem({
      number: 14,
      title: "Safer auth",
      state: "open",
      user: { login: "author" },
      head: { ref: "auth" },
      base: { ref: "main" },
      labels: [{ name: "security", color: "d73a4a" }],
      comments: 2,
      review_comments: 3,
      assignees: [{ login: "OCTOCAT" }],
      requested_reviewers: [{ login: "octocat" }]
    }, "acme/widget", "octocat")).toMatchObject({
      repository: "acme/widget",
      comments: 5,
      assignedToViewer: true,
      reviewRequestedFromViewer: true,
      labels: [{ name: "security", color: "d73a4a" }]
    })
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

  it("keeps the newest occurrence of each case-insensitive check name", () => {
    const check = (name: string, status: "pass" | "fail") => ({ name, status, detailsUrl: null, durationMs: null })
    expect(dedupeChecks([
      check("QA Verify", "pass"),
      check("qa verify", "fail"),
      check("Typecheck", "pass")
    ])).toEqual([check("QA Verify", "pass"), check("Typecheck", "pass")])
  })

  it("maps pull request commit evidence", () => {
    expect(mapPrCommit({
      sha: "abc123",
      url: "https://api.github.com/repos/acme/widget/commits/abc123",
      html_url: "https://github.com/acme/widget/commit/abc123",
      author: { login: "octocat" },
      commit: {
        message: "fix auth\n\nLong body",
        author: { name: "Octo Cat", date: "2026-08-26T08:00:00Z" },
        verification: { verified: true }
      }
    })).toEqual({
      sha: "abc123",
      message: "fix auth",
      author: "octocat",
      committedAt: "2026-08-26T08:00:00Z",
      url: "https://github.com/acme/widget/commit/abc123",
      verified: true
    })
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
  it("keeps diff headers separate from header-like content and resets hunk bounds", () => {
    const diff = [
      "diff --git a/first.ts b/first.ts",
      "--- a/first.ts",
      "+++ b/first.ts",
      "@@ -1 +3,2 @@",
      "+++ this is added content",
      "\\ No newline at end of file",
      " context",
      "+outside declared hunk",
      "@@ -8 +10 @@",
      "-removed",
      "+replacement",
      "diff --git a/deleted.ts b/deleted.ts",
      "--- a/deleted.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-deleted",
      "diff --git a/next.ts b/next.ts",
      "--- a/next.ts",
      "+++ b/next.ts",
      "@@ -0,0 +1 @@",
      "+new"
    ].join("\n")
    const anchors = postableLines(diff)
    expect([...anchors.keys()]).toEqual(["first.ts", "next.ts"])
    expect([...anchors.get("first.ts")!]).toEqual([3, 4, 10])
    expect([...anchors.get("next.ts")!]).toEqual([1])
  })

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
