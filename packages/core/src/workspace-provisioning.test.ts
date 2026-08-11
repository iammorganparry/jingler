import { describe, expect, it } from "vitest"
import { createWorkspaceProvisioningPlan } from "./workspace-provisioning.js"

const sha = "a".repeat(40)

describe("WorkspaceProvisioningPlan", () => {
  it.each([
    ["new", { kind: "new" } as const],
    [
      "pull request",
      { kind: "pull-request", pullRequestNumber: 42 } as const
    ],
    [
      "resumed",
      { kind: "resume", sourceSessionId: "session_source" } as const
    ],
    [
      "handed off",
      {
        kind: "handoff",
        sourceSessionId: "session_source",
        checkpointId: "checkpoint_1",
        eventCursor: 12
      } as const
    ]
  ])("plans an exact %s workspace without credentials", (_label, source) => {
    const plan = createWorkspaceProvisioningPlan({
      githubSlug: "jingler/example",
      headSha: sha,
      branch: "feature/cloud",
      baseBranch: "main",
      createBranch: source.kind === "new",
      source
    })
    expect(plan).toMatchObject({
      repository: { provider: "github", slug: "jingler/example" },
      headSha: sha,
      branch: "feature/cloud",
      source
    })
    expect(JSON.stringify(plan)).not.toMatch(/token|secret|credential/iu)
  })

  it("rejects branch injection and non-exact revisions", () => {
    expect(() =>
      createWorkspaceProvisioningPlan({
        githubSlug: "jingler/example",
        headSha: "main",
        branch: "feature/cloud; rm -rf workspace",
        baseBranch: "main",
        createBranch: true,
        source: { kind: "new" }
      })
    ).toThrow()
  })
})
