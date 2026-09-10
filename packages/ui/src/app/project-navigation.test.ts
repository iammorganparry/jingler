import { describe, expect, it } from "vitest"
import type { Project, Session } from "@jingler/core"
import { testSession } from "../test-support.js"
import { projectIdForSession, UNASSIGNED_PROJECT_ID } from "./project-navigation.js"

const project = (values: Partial<Project> & Pick<Project, "id" | "name" | "path">): Project => ({
  availability: "available",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...values
})

const session = (values: Partial<Session> & Pick<Session, "id">): Session =>
  testSession({ repo: "same", updatedAt: "2026-01-01T00:00:00.000Z", ...values })

describe("project navigation", () => {
  const projects = [
    project({ id: "a", name: "same", path: "/repos/a" }),
    project({ id: "b", name: "same", path: "/repos/b" })
  ]

  it("prefers durable project identity over duplicate names", () => {
    expect(projectIdForSession(session({ id: "s", projectId: "b", repoPath: "/repos/a" }), projects)).toBe("b")
  })

  it("uses origin path and leaves ambiguous legacy names unassigned", () => {
    expect(projectIdForSession(session({ id: "path", repoPath: "/repos/a" }), projects)).toBe("a")
    expect(projectIdForSession(session({ id: "name" }), projects)).toBe(UNASSIGNED_PROJECT_ID)
  })

  it("scopes legacy matching to the environment", () => {
    const remote = project({ id: "remote", name: "same", path: "/repos/a", environmentId: "device" })
    expect(projectIdForSession(session({ id: "local", repoPath: "/repos/a" }), [...projects, remote])).toBe("a")
    expect(projectIdForSession(session({ id: "remote", repoPath: "/repos/a", environmentId: "device" }), [...projects, remote])).toBe("remote")
  })

})
