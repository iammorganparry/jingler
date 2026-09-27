/**
 * Story fixtures for the changes review flow: one repository, two change sets
 * (the worktree's uncommitted edits, and the pull request's full diff), a PR
 * review thread and an adversarial review. Stories only — not exported.
 */
import type {
  AdversarialReview,
  AssetFileEntry,
  PrFileChange,
  PrReviewThread
} from "@jingler/core"
import type { ReviewOmittedFile } from "../composites/changes-review.js"
import type { ReviewDraft } from "../composites/review-tray.js"

interface Hunk {
  readonly start: number
  readonly context: readonly string[]
  readonly removed: readonly string[]
  readonly added: readonly string[]
  readonly after?: readonly string[]
}

const patch = (path: string, hunks: readonly Hunk[], status: "modified" | "added" = "modified"): string => {
  const header =
    status === "added"
      ? [`diff --git a/${path} b/${path}`, "new file mode 100644", "--- /dev/null", `+++ b/${path}`]
      : [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`]
  const body = hunks.flatMap((hunk) => {
    const after = hunk.after ?? []
    const oldCount = hunk.context.length + hunk.removed.length + after.length
    const newCount = hunk.context.length + hunk.added.length + after.length
    return [
      `@@ -${status === "added" ? 0 : hunk.start},${status === "added" ? 0 : oldCount} +${hunk.start},${newCount} @@`,
      ...hunk.context.map((line) => ` ${line}`),
      ...hunk.removed.map((line) => `-${line}`),
      ...hunk.added.map((line) => `+${line}`),
      ...after.map((line) => ` ${line}`)
    ]
  })
  return [...header, ...body, ""].join("\n")
}

const counts = (hunks: readonly Hunk[]) => ({
  additions: hunks.reduce((sum, hunk) => sum + hunk.added.length, 0),
  deletions: hunks.reduce((sum, hunk) => sum + hunk.removed.length, 0)
})

interface ChangeFixture {
  readonly path: string
  readonly hunks: readonly Hunk[]
  readonly status?: "modified" | "added"
  readonly commentCount?: number
}

const change = (fixture: ChangeFixture) => ({
  file: {
    path: fixture.path,
    ...counts(fixture.hunks),
    commentCount: fixture.commentCount ?? 0,
    viewed: false
  } satisfies PrFileChange,
  diff: { path: fixture.path, diff: patch(fixture.path, fixture.hunks, fixture.status) }
})

const session = change({
  path: "src/auth/session.ts",
  commentCount: 1,
  hunks: [
    {
      start: 31,
      context: ["export async function session(req: Request, next: Next) {", "  const s = req.session"],
      removed: ["  if (!s.token) return next()"],
      added: ["  if (isExpired(s.token)) {", "    await refresh(s)", "  }"],
      after: ["  return next()", "}"]
    }
  ]
})

const refresh = change({
  path: "src/auth/refresh.ts",
  status: "added",
  hunks: [
    {
      start: 1,
      context: [],
      removed: [],
      added: [
        'import { fetchToken } from "./client"',
        "",
        "export async function refresh(session: Session) {",
        "  for (let attempt = 0; ; attempt += 1) {",
        "    const token = await fetchToken(session.refreshToken)",
        "    if (token.ok) return (session.token = token.value)",
        "  }",
        "}"
      ]
    }
  ]
})

const config = change({
  path: "config/auth.json",
  hunks: [
    {
      start: 1,
      context: ["{"],
      removed: ['  "ttl": 3600'],
      added: ['  "ttl": 900,', '  "refreshWindow": 60'],
      after: ["}"]
    }
  ]
})

const test = change({
  path: "src/auth/session.test.ts",
  hunks: [
    {
      start: 12,
      context: ['describe("session", () => {'],
      removed: [],
      added: ['  it("refreshes an expired token", async () => {', "    expect(await run(expired)).toBe(fresh)", "  })"],
      after: ["})"]
    }
  ]
})

const docs = change({
  path: "docs/auth.md",
  hunks: [
    {
      start: 4,
      context: ["## Sessions"],
      removed: ["Tokens last an hour."],
      added: ["Tokens last fifteen minutes and refresh in the background."],
      after: [""]
    }
  ]
})

const styles = change({
  path: "src/ui/login.css",
  hunks: [
    {
      start: 8,
      context: [".login {"],
      removed: ["  gap: 8px;"],
      added: ["  gap: 12px;"],
      after: ["}"]
    }
  ]
})

/** The worktree's uncommitted edits — what "Uncommitted" lists. */
export const localChanges = [session, config, test]

/** Everything the PR changes — a superset of the uncommitted work. */
export const prChanges = [session, refresh, config, test, docs, styles]

export const repositoryEntries: readonly AssetFileEntry[] = [
  { path: "README.md", status: "clean" },
  { path: "package.json", status: "clean" },
  { path: "config/auth.json", status: "modified" },
  { path: "docs/auth.md", status: "clean" },
  { path: "src/auth/client.ts", status: "clean" },
  { path: "src/auth/refresh.ts", status: "clean" },
  { path: "src/auth/session.test.ts", status: "modified" },
  { path: "src/auth/session.ts", status: "modified" },
  { path: "src/index.ts", status: "clean" },
  { path: "src/ui/login.css", status: "clean" },
  { path: "src/ui/login.tsx", status: "clean" }
]

/** Plain source for files opened without a diff (the "All files" route). */
export const sourceFor = (path: string): string =>
  [
    `// ${path}`,
    "",
    "export function example() {",
    "  // The Files view's editor renders here in the app.",
    "  return true",
    "}"
  ].join("\n")

export const prThreads: readonly PrReviewThread[] = [
  {
    id: "thread-1",
    reviewId: null,
    path: "src/auth/session.ts",
    line: 33,
    startLine: null,
    originalLine: null,
    originalStartLine: null,
    diffHunk: "",
    isResolved: false,
    isOutdated: false,
    resolvedBy: null,
    comments: [
      {
        id: "comment-1",
        databaseId: 1,
        author: "reviewer",
        authorAvatarUrl: null,
        isBot: false,
        association: "MEMBER",
        body: "Should an expired token refresh inline, or fail the request and let the client retry?",
        createdAt: "2026-09-20T10:00:00.000Z",
        reactions: []
      }
    ]
  }
]

export const adversarialReview: AdversarialReview = {
  sessionId: "changes-pr",
  prNumber: 482,
  headSha: "a1b2c3d",
  connectionId: null,
  providerId: null,
  modelId: null,
  legacyModel: "claude-fable-5",
  createdAt: "2026-09-20T10:00:00.000Z",
  note: null,
  routedAt: null,
  postedAt: null,
  postError: null,
  findings: [
    {
      id: "f-refresh-loop",
      path: "src/auth/refresh.ts",
      line: 4,
      endLine: 7,
      severity: "major",
      title: "Refresh retries forever on a revoked token",
      rationale:
        "The loop has no terminal case for a 401, so a revoked refresh token spins until the request times out.",
      suggestion: "Break on 4xx and surface the failure to the caller.",
      resolvedBy: null
    },
    {
      id: "f-ttl",
      path: "config/auth.json",
      line: 2,
      endLine: null,
      severity: "minor",
      title: "A 15 minute TTL triples refresh traffic",
      rationale: "Every active session now refreshes four times an hour.",
      suggestion: null,
      resolvedBy: null
    },
    {
      id: "f-general",
      path: null,
      line: null,
      endLine: null,
      severity: "minor",
      title: "No test covers a revoked refresh token",
      rationale: "The new tests exercise the happy path only; the risky branch is untested.",
      suggestion: null,
      resolvedBy: null
    }
  ]
}

export const sampleDrafts: readonly ReviewDraft[] = [
  {
    id: "draft-1",
    path: "src/auth/session.ts",
    line: 32,
    endLine: 34,
    body: "Pull the expiry check into a helper so the middleware stays one line.",
    routeToAgent: true
  },
  {
    id: "draft-2",
    path: "config/auth.json",
    line: 2,
    endLine: null,
    body: "Document why 900 seconds.",
    routeToAgent: false
  }
]

export const omittedFiles: readonly ReviewOmittedFile[] = [
  { path: "pnpm-lock.yaml", added: 4210, removed: 3988, reason: "lines" },
  { path: "assets/logo.svg", added: 1, removed: 1, reason: "bytes" }
]
