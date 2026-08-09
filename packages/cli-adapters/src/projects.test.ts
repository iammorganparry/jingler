import { join } from "node:path"
import { Effect } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { initGitRepo, mkTemp, runExit, withTempRoot } from "./test-support.js"
import { ProjectService } from "./projects.js"

describe("ProjectService", () => {
  let temp: ReturnType<typeof withTempRoot>
  let repos: ReturnType<typeof mkTemp>

  beforeEach(() => {
    temp = withTempRoot()
    repos = mkTemp("jingler-projects-")
  })

  afterEach(() => {
    temp.cleanup()
    repos.cleanup()
  })

  it("persists registered projects with stable ids across store reconstruction", async () => {
    const repoPath = initGitRepo(join(repos.dir, "atlas"))
    const first = await runExit(
      ProjectService.register({ path: repoPath }).pipe(
        Effect.provide(ProjectService.Default)
      ),
      temp.layer
    )
    expect(first._tag).toBe("Success")
    if (first._tag !== "Success") return

    const second = await runExit(
      ProjectService.list().pipe(Effect.provide(ProjectService.Default)),
      temp.layer
    )
    expect(second._tag).toBe("Success")
    if (second._tag !== "Success") return
    expect(second.value).toHaveLength(1)
    expect(second.value[0]).toMatchObject({
      id: first.value.id,
      name: "atlas",
      path: repoPath,
      availability: "available"
    })
  })

  it("backfills one project per legacy repository without mutating sessions", async () => {
    const alpha = initGitRepo(join(repos.dir, "alpha"))
    const beta = initGitRepo(join(repos.dir, "beta"))
    const legacy = [
      { id: "s-1", repoPath: alpha, repo: "alpha" },
      { id: "s-2", repoPath: alpha, repo: "alpha" },
      { id: "s-3", repoPath: beta, repo: "beta" }
    ] as const
    const before = JSON.stringify(legacy)

    const result = await runExit(
      ProjectService.backfill(
        legacy.map((session) => ({ path: session.repoPath, name: session.repo }))
      ).pipe(Effect.provide(ProjectService.Default)),
      temp.layer
    )

    expect(result._tag).toBe("Success")
    if (result._tag !== "Success") return
    expect(result.value.map((project) => project.name)).toEqual(["alpha", "beta"])
    expect(JSON.stringify(legacy)).toBe(before)
  })

  it("returns a missing registration without deleting its identity", async () => {
    const repoPath = initGitRepo(join(repos.dir, "movable"))
    const registered = await runExit(
      ProjectService.register({ path: repoPath }).pipe(
        Effect.provide(ProjectService.Default)
      ),
      temp.layer
    )
    expect(registered._tag).toBe("Success")
    repos.cleanup()

    const listed = await runExit(
      ProjectService.list().pipe(Effect.provide(ProjectService.Default)),
      temp.layer
    )
    expect(listed._tag).toBe("Success")
    if (listed._tag !== "Success" || registered._tag !== "Success") return
    expect(listed.value).toEqual([
      expect.objectContaining({ id: registered.value.id, availability: "missing" })
    ])
  })
})
