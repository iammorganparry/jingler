import { createWorkspaceProvisioningPlan } from "@jingler/core"
import { describe, expect, it } from "vitest"
import { hydrateWorkspace, type WorkspaceCommandExecutor } from "./workspace-hydration.js"

const headSha = "a".repeat(40)

const executor = (
  expectedBranch: string
): {
  executor: WorkspaceCommandExecutor
  commands: string[]
  calls: Array<{
    command: string
    options: Parameters<WorkspaceCommandExecutor["exec"]>[1]
  }>
} => {
  const commands: string[] = []
  const calls: Array<{
    command: string
    options: Parameters<WorkspaceCommandExecutor["exec"]>[1]
  }> = []
  return {
    commands,
    calls,
    executor: {
      exec: async (command, options) => {
        commands.push(command)
        calls.push({ command, options })
        return {
          success: true,
          stdout:
            command === "git rev-parse HEAD"
              ? headSha
              : command === "git branch --show-current"
                ? expectedBranch
                : "",
          stderr: ""
        }
      }
    }
  }
}

const plan = (
  source:
    | { readonly kind: "new" }
    | { readonly kind: "pull-request"; readonly pullRequestNumber: number }
    | { readonly kind: "resume"; readonly sourceSessionId: string }
    | {
        readonly kind: "handoff"
        readonly sourceSessionId: string
        readonly checkpointId: string
        readonly eventCursor: number
      }
) =>
  createWorkspaceProvisioningPlan({
    githubSlug: "jingler/example",
    headSha,
    branch: "feature/cloud",
    baseBranch: "main",
    createBranch: source.kind === "new",
    source
  })

describe("managed workspace hydration", () => {
  it.each([
    ["new", { kind: "new" } as const],
    ["PR", { kind: "pull-request", pullRequestNumber: 42 } as const],
    ["resumed", { kind: "resume", sourceSessionId: "session_source" } as const],
    [
      "handed-off",
      {
        kind: "handoff",
        sourceSessionId: "session_source",
        checkpointId: "checkpoint_1",
        eventCursor: 9
      } as const
    ]
  ])("hydrates %s session at exact commit and branch", async (_label, source) => {
    const fake = executor("feature/cloud")
    await expect(
      hydrateWorkspace(
        fake.executor,
        plan(source),
        "https://managed-runtime.jingler.dev/v1/git/jingler/example.git"
      )
    ).resolves.toEqual({
      headSha,
      branch: "feature/cloud",
      path: "/workspace"
    })
    expect(fake.commands).toContain(`git fetch --no-tags --depth=1 origin '${headSha}'`)
    expect(fake.commands).toContain(`git checkout --quiet --force -B 'feature/cloud' '${headSha}'`)
  })

  it("is idempotent and never installs dependency trees", async () => {
    const fake = executor("feature/cloud")
    await hydrateWorkspace(
      fake.executor,
      plan({ kind: "resume", sourceSessionId: "session_source" }),
      "https://managed-runtime.jingler.dev/v1/git/jingler/example.git"
    )
    expect(fake.commands.join("\n")).not.toMatch(/pnpm|npm install|node_modules/iu)
    expect(fake.commands[0]).toBe("test -d .git || git init --quiet .")
  })

  it("hydrates a public repository without an authorization header", async () => {
    const fake = executor("feature/cloud")
    await hydrateWorkspace(
      fake.executor,
      plan({ kind: "new" }),
      "https://github.com/jingler/example.git",
      { canonicalRepositoryUrl: "https://github.com/jingler/example.git" }
    )
    const fetch = fake.calls.find(({ command }) => command.includes("fetch"))
    expect(fetch?.command).toBe(`git fetch --no-tags --depth=1 origin '${headSha}'`)
    expect(fetch?.options.env).toBeUndefined()
  })

  it("uses only an opaque proxy capability and restores the canonical remote", async () => {
    const fake = executor("feature/cloud")
    await hydrateWorkspace(
      fake.executor,
      plan({ kind: "new" }),
      "https://managed-runtime.jingler.dev/v1/git/session_1/jingler/example.git",
      {
        authorizationHeader: "Bearer git_opaque_capability",
        canonicalRepositoryUrl: "https://github.com/jingler/example.git"
      }
    )
    expect(fake.commands).toContain(
      `git --config-env=http.extraHeader=JINGLER_GIT_AUTHORIZATION fetch --no-tags --depth=1 origin '${headSha}'`
    )
    expect(fake.commands.join("\n")).not.toContain("git_opaque_capability")
    expect(fake.calls.find(({ command }) => command.includes("fetch"))?.options.env).toEqual({
      JINGLER_GIT_AUTHORIZATION: "Authorization: Bearer git_opaque_capability"
    })
    expect(fake.commands.at(-1)).toBe(
      "git remote set-url origin 'https://github.com/jingler/example.git'"
    )
  })
})
