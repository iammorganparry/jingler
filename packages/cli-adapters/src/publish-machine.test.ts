import { describe, expect, it, vi } from "vitest"
import type { PublishCheckpoint, PublishMetadata } from "@jingler/core"
import {
  runPublishMachine,
  runPublishMachineExclusive,
  type PublishOperations
} from "./publish-machine.js"

const metadata: PublishMetadata = {
  commitMessage: "feat: publish deterministic pull request",
  prTitle: "Publish deterministic pull request",
  prBody: "## Summary\n\nPublish it."
}

const operations = (overrides: Partial<PublishOperations> = {}): PublishOperations => ({
  inspect: vi.fn(async () => ({
    branch: "feat/deterministic-publish",
    hasChanges: true,
    unpublished: 0,
    changedPaths: ["src/publish.ts"],
    diffSummary: "1 file changed",
    headSha: "before"
  })),
  verifyBranch: vi.fn(async (inspection) => {
    if (!inspection.branch) throw new Error("detached")
    return inspection.branch
  }),
  generateMetadata: vi.fn(async () => metadata),
  stage: vi.fn(async () => undefined),
  commit: vi.fn(async () => "commit-sha"),
  authenticate: vi.fn(async () => undefined),
  push: vi.fn(async () => undefined),
  resolvePr: vi.fn(async () => null),
  createPr: vi.fn(async () => 42),
  updatePr: vi.fn(async () => undefined),
  link: vi.fn(async () => undefined),
  ...overrides
})

describe("deterministic publish machine", () => {
  it("commits, pushes, creates, updates, and links in order", async () => {
    const order: string[] = []
    const ops = operations({
      stage: vi.fn(async () => { order.push("stage") }),
      commit: vi.fn(async () => { order.push("commit"); return "commit-sha" }),
      authenticate: vi.fn(async () => { order.push("authenticate") }),
      push: vi.fn(async () => { order.push("push") }),
      resolvePr: vi.fn(async () => { order.push("resolve"); return null }),
      createPr: vi.fn(async () => { order.push("create"); return 42 }),
      updatePr: vi.fn(async () => { order.push("update") }),
      link: vi.fn(async () => { order.push("link") })
    })
    const seen: PublishCheckpoint[] = []
    const result = await runPublishMachine(undefined, ops, async () => undefined, (value) => seen.push(value))

    expect(result.step).toBe("complete")
    expect(result).toMatchObject({ branch: "feat/deterministic-publish", commitSha: "commit-sha", prNumber: 42 })
    expect(order).toEqual(["stage", "commit", "authenticate", "push", "resolve", "create", "update", "link"])
    expect(seen.some((value) => value.step === "pushing")).toBe(true)
    expect(result.completed).toEqual([
      "inspecting", "verifying-branch", "generating-metadata", "staging", "committing",
      "authenticating", "pushing", "resolving-pr", "creating-pr", "updating-pr", "linking"
    ])
  })

  it("reuses persisted metadata and an existing PR after retry", async () => {
    const ops = operations({
      inspect: vi.fn(async () => ({
        branch: "fix/retry-publish",
        hasChanges: false,
        unpublished: 1,
        changedPaths: [],
        diffSummary: "",
        headSha: "commit-sha"
      })),
      resolvePr: vi.fn(async () => 42)
    })
    const checkpoint: PublishCheckpoint = {
      step: "failed",
      completed: ["inspecting", "generating-metadata", "staging", "committing"],
      metadata,
      branch: "fix/retry-publish",
      commitSha: "commit-sha",
      error: "network",
      resumeFrom: "pushing",
      updatedAt: new Date().toISOString()
    }
    const result = await runPublishMachine(checkpoint, ops, async () => undefined)

    expect(result.step).toBe("complete")
    expect(ops.generateMetadata).not.toHaveBeenCalled()
    expect(ops.stage).not.toHaveBeenCalled()
    expect(ops.commit).not.toHaveBeenCalled()
    expect(ops.createPr).not.toHaveBeenCalled()
    expect(ops.updatePr).toHaveBeenCalledWith(42, metadata)
  })

  it("persists the failing stage for actionable retry", async () => {
    const ops = operations({ push: vi.fn(async () => { throw new Error("push rejected") }) })
    const result = await runPublishMachine(undefined, ops, async () => undefined)
    expect(result).toMatchObject({ step: "failed", resumeFrom: "pushing", error: "push rejected" })
    expect(result.completed).toEqual(expect.arrayContaining(["inspecting", "generating-metadata", "staging", "committing", "authenticating"]))
  })

  it("refuses a detached worktree before metadata, stage, push, or GitHub writes", async () => {
    const ops = operations({
      inspect: vi.fn(async () => ({
        branch: null,
        hasChanges: true,
        unpublished: 0,
        changedPaths: ["src/publish.ts"],
        diffSummary: "1 file changed",
        headSha: "detached-sha"
      })),
      verifyBranch: vi.fn(async () => {
        throw new Error("Finish creating the semantic task branch before publishing.")
      })
    })

    const result = await runPublishMachine(undefined, ops, async () => undefined)

    expect(result).toMatchObject({
      step: "failed",
      resumeFrom: "verifying-branch",
      error: "Finish creating the semantic task branch before publishing."
    })
    expect(result.completed).toEqual(["inspecting"])
    expect(ops.generateMetadata).not.toHaveBeenCalled()
    expect(ops.stage).not.toHaveBeenCalled()
    expect(ops.push).not.toHaveBeenCalled()
    expect(ops.createPr).not.toHaveBeenCalled()
  })

  it("retries branch verification after semantic branch creation completes", async () => {
    let detached = true
    const ops = operations({
      inspect: vi.fn(async () => ({
        branch: detached ? null : "fix/finish-branch",
        hasChanges: true,
        unpublished: 0,
        changedPaths: ["src/publish.ts"],
        diffSummary: "1 file changed",
        headSha: "before"
      })),
      verifyBranch: vi.fn(async (inspection) => {
        if (!inspection.branch) throw new Error("semantic branch pending")
        return inspection.branch
      })
    })

    const interrupted = await runPublishMachine(undefined, ops, async () => undefined)
    detached = false
    const recovered = await runPublishMachine(interrupted, ops, async () => undefined)

    expect(interrupted).toMatchObject({ step: "failed", resumeFrom: "verifying-branch" })
    expect(recovered).toMatchObject({ step: "complete", branch: "fix/finish-branch" })
    expect(ops.stage).toHaveBeenCalledOnce()
    expect(ops.commit).toHaveBeenCalledOnce()
    expect(ops.createPr).toHaveBeenCalledOnce()
  })

  it("does not report skipped commit or create steps as completed", async () => {
    const ops = operations({
      inspect: vi.fn(async () => ({
        branch: "fix/already-committed",
        hasChanges: false,
        unpublished: 1,
        changedPaths: ["src/publish.ts"],
        diffSummary: "1 file changed",
        headSha: "existing-sha"
      })),
      resolvePr: vi.fn(async () => 42)
    })

    const result = await runPublishMachine(undefined, ops, async () => undefined)

    expect(result.step).toBe("complete")
    expect(result.completed).not.toContain("staging")
    expect(result.completed).not.toContain("committing")
    expect(result.completed).not.toContain("creating-pr")
  })

  it("rejects unsafe metadata recovered from a durable checkpoint", async () => {
    const generateMetadata = vi.fn(async () => metadata)
    const checkpoint: PublishCheckpoint = {
      step: "failed",
      completed: ["inspecting", "verifying-branch"],
      metadata: {
        commitMessage: "feat: $(touch publish-owned)",
        prTitle: "Unsafe",
        prBody: "Unsafe"
      },
      resumeFrom: "committing",
      updatedAt: new Date().toISOString()
    }

    await runPublishMachine(checkpoint, operations({ generateMetadata }), async () => undefined)

    expect(generateMetadata).toHaveBeenCalledOnce()
  })

  it("generates fresh metadata for work published after a completed checkpoint", async () => {
    const generateMetadata = vi.fn(async () => metadata)
    const prior: PublishCheckpoint = {
      step: "complete",
      completed: ["inspecting", "verifying-branch", "generating-metadata", "staging", "committing", "authenticating", "pushing", "resolving-pr", "creating-pr", "updating-pr", "linking"],
      metadata: { ...metadata, commitMessage: "fix: stale metadata" },
      prNumber: 41,
      updatedAt: new Date().toISOString()
    }
    await runPublishMachine(prior, operations({ generateMetadata, resolvePr: vi.fn(async () => 42) }), async () => undefined)
    expect(generateMetadata).toHaveBeenCalledOnce()
  })

  it("coalesces duplicate publish clicks into one mutation sequence", async () => {
    let releaseStage!: () => void
    const stageGate = new Promise<void>((resolve) => { releaseStage = resolve })
    const ops = operations({ stage: vi.fn(() => stageGate) })
    const key = `duplicate-${crypto.randomUUID()}`

    const first = runPublishMachineExclusive(key, undefined, ops, async () => undefined)
    const duplicate = runPublishMachineExclusive(key, undefined, ops, async () => undefined)
    releaseStage()
    const [firstResult, duplicateResult] = await Promise.all([first, duplicate])

    expect(firstResult.step).toBe("complete")
    expect(duplicateResult).toEqual(firstResult)
    expect(ops.stage).toHaveBeenCalledOnce()
    expect(ops.commit).toHaveBeenCalledOnce()
    expect(ops.push).toHaveBeenCalledOnce()
    expect(ops.createPr).toHaveBeenCalledOnce()
    expect(ops.link).toHaveBeenCalledOnce()
  })

  it.each([
    ["commit", "committing"],
    ["push", "pushing"],
    ["create", "creating-pr"],
    ["body", "updating-pr"],
    ["link", "linking"]
  ] as const)("resumes after a restart at %s without duplicating the commit or PR", async (
    failureStage,
    resumeFrom
  ) => {
    let hasChanges = true
    let pullRequest: number | null = null
    let failed = false
    let commits = 0
    let successfulCreates = 0
    const ops = operations({
      inspect: vi.fn(async () => ({
        branch: "fix/restart-safe-publish",
        hasChanges,
        unpublished: hasChanges ? 0 : 1,
        changedPaths: hasChanges ? ["src/publish.ts"] : [],
        diffSummary: "1 file changed",
        headSha: hasChanges ? "before" : "commit-sha"
      })),
      commit: vi.fn(async () => {
        commits += 1
        hasChanges = false
        if (failureStage === "commit" && !failed) {
          failed = true
          throw new Error("commit response interrupted")
        }
        return "commit-sha"
      }),
      push: vi.fn(async () => {
        if (failureStage === "push" && !failed) {
          failed = true
          throw new Error("push interrupted")
        }
      }),
      resolvePr: vi.fn(async () => pullRequest),
      createPr: vi.fn(async () => {
        if (failureStage === "create" && !failed) {
          failed = true
          throw new Error("create interrupted")
        }
        pullRequest = 42
        successfulCreates += 1
        return 42
      }),
      updatePr: vi.fn(async () => {
        if (failureStage === "body" && !failed) {
          failed = true
          throw new Error("body interrupted")
        }
      }),
      link: vi.fn(async () => {
        if (failureStage === "link" && !failed) {
          failed = true
          throw new Error("link interrupted")
        }
      })
    })

    const interrupted = await runPublishMachine(undefined, ops, async () => undefined)
    expect(interrupted).toMatchObject({ step: "failed", resumeFrom })

    // A new machine represents the Electron main process restarting and
    // loading the durable checkpoint from the session store.
    const recovered = await runPublishMachine(interrupted, ops, async () => undefined)
    expect(recovered).toMatchObject({ step: "complete", commitSha: "commit-sha", prNumber: 42 })
    expect(commits).toBe(1)
    expect(successfulCreates).toBe(1)
  })
})
