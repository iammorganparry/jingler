import { expect, it } from "vitest"
import { trustedWorkspaceEnvironment, workspaceEnvironment, workspaceProcessEnvironment } from "./workspace-environment.js"

it("injects isolated workspace paths without managed ports", () => {
  const session = { worktreePath: "/work", repoPath: "/root" }
  expect(workspaceEnvironment(session)).toEqual({ JINGLER_WORKSPACE_PATH: "/work", JINGLER_ROOT_PATH: "/root" })
  expect(workspaceProcessEnvironment({ PATH: "/bin", JINGLER_WORKSPACE_PATH: "/other" }, session)).toEqual({ PATH: "/bin", ...workspaceEnvironment(session) })
  expect(workspaceEnvironment({ ...session, environmentId: "remote" })).toEqual({})
  expect(workspaceEnvironment({ ...session, workspaceMode: "direct" })).toEqual({})
})
it("trusts only workspace paths across credential filtering", () => {
  expect(trustedWorkspaceEnvironment({ JINGLER_PORT: "3100", JINGLER_API_PORT: "3101", JINGLER_ROOT_PATH: "/root", JINGLER_WORKSPACE_PATH: "bad\0path", ANTHROPIC_API_KEY: "secret" })).toEqual({ JINGLER_ROOT_PATH: "/root" })
})
