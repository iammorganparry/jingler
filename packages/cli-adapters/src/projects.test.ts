import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { delimiter, join } from "node:path"
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

  it("hides unmarked legacy registrations without deleting them and restores an explicit re-import", async () => {
    const repoPath = initGitRepo(join(repos.dir, "legacy"))
    const registered = await runExit(ProjectService.register({ path: repoPath }).pipe(Effect.provide(ProjectService.Default)), temp.layer)
    if (registered._tag !== "Success") throw new Error("Registration failed")
    const file = join(temp.root, "projects.json")
    const legacy = { ...registered.value, imported: undefined }
    writeFileSync(file, JSON.stringify([legacy]))

    const hidden = await runExit(ProjectService.backfill([]).pipe(Effect.provide(ProjectService.Default)), temp.layer)
    expect(hidden).toMatchObject({ _tag: "Success", value: [] })
    expect(JSON.parse(readFileSync(file, "utf8"))).toHaveLength(1)
    expect(existsSync(join(repoPath, ".git"))).toBe(true)

    const restored = await runExit(ProjectService.register({ path: repoPath }).pipe(Effect.provide(ProjectService.Default)), temp.layer)
    expect(restored).toMatchObject({ _tag: "Success", value: { id: legacy.id, imported: true, createdAt: legacy.createdAt } })
    const listed = await runExit(ProjectService.backfill([]).pipe(Effect.provide(ProjectService.Default)), temp.layer)
    expect(listed).toMatchObject({ _tag: "Success", value: [{ id: legacy.id, imported: true }] })
  })

  it("recovers session-referenced legacy registrations even when missing, but not remote-only references", async () => {
    mkdirSync(temp.root, { recursive: true })
    const file = join(temp.root, "projects.json")
    const legacy = ["by-id", "by-path", "remote-only", "unused"].map((id) => ({
      id, name: id, path: join(repos.dir, id), availability: "missing",
      createdAt: "2026-01-01", updatedAt: "2026-01-01"
    }))
    writeFileSync(file, JSON.stringify(legacy))
    const result = await runExit(ProjectService.backfill([
      { projectId: "by-id", repo: "by-id" },
      { repoPath: join(repos.dir, "by-path"), repo: "by-path" },
      { projectId: "remote-only", repo: "remote-only", environmentId: "device" }
    ]).pipe(Effect.provide(ProjectService.Default)), temp.layer)
    expect(result).toMatchObject({ _tag: "Success", value: [
      { id: "by-id", imported: true, availability: "missing" },
      { id: "by-path", imported: true, availability: "missing" }
    ] })
    expect(JSON.parse(readFileSync(file, "utf8"))).toHaveLength(4)
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
      ProjectService.backfill(legacy).pipe(Effect.provide(ProjectService.Default)),
      temp.layer
    )

    expect(result._tag).toBe("Success")
    if (result._tag !== "Success") return
    expect(result.value.map((project) => project.name)).toEqual(["alpha", "beta"])
    expect(JSON.stringify(legacy)).toBe(before)
  })

  it("skips stale legacy paths without failing or discarding valid projects", async () => {
    const valid = initGitRepo(join(repos.dir, "valid"))
    const missing = join(repos.dir, "deleted-worktree")

    const result = await runExit(
      ProjectService.backfill([
        { repoPath: missing, repo: "deleted" },
        { repoPath: valid, repo: "valid" }
      ]).pipe(Effect.provide(ProjectService.Default)),
      temp.layer
    )

    expect(result._tag).toBe("Success")
    if (result._tag !== "Success") return
    expect(result.value).toEqual([
      expect.objectContaining({ name: "valid", path: valid, availability: "available" })
    ])
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

  it("creates and initialises a new local repository", async () => {
    const destination = join(repos.dir, "new-project")
    const result = await runExit(
      ProjectService.createDirectory({ path: destination, name: "New project" }).pipe(
        Effect.provide(ProjectService.Default)
      ),
      temp.layer
    )

    expect(result._tag).toBe("Success")
    expect(existsSync(join(destination, ".git"))).toBe(true)
    if (result._tag === "Success") {
      expect(result.value).toMatchObject({ name: "New project", path: destination })
    }
  })

  it("clones projects without allowing interactive credential prompts", async () => {
    const origin = initGitRepo(join(repos.dir, "origin"))
    const destination = join(repos.dir, "checkout")
    const bin = join(repos.dir, "bin")
    const invocation = join(repos.dir, "git-invocation.txt")
    mkdirSync(bin)
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\nprintf '%s\\n%s\\n%s\\n%s\\n' "$GIT_TERMINAL_PROMPT" "$GCM_INTERACTIVE" "$SSH_ASKPASS_REQUIRE" "$*" > "$JINGLER_GIT_INVOCATION"\nexec /usr/bin/git "$@"\n`
    )
    chmodSync(join(bin, "git"), 0o755)
    const previousPath = process.env.PATH
    const previousInvocation = process.env.JINGLER_GIT_INVOCATION
    process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`
    process.env.JINGLER_GIT_INVOCATION = invocation

    try {
      const result = await runExit(
        ProjectService.clone({ url: origin, destination }).pipe(
          Effect.provide(ProjectService.Default)
        ),
        temp.layer
      )
      expect(result._tag).toBe("Success")
      expect(readFileSync(invocation, "utf8")).toBe([
        "0",
        "Never",
        "never",
        `-c credential.interactive=never clone -- ${origin} ${destination}`,
        ""
      ].join("\n"))
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
      if (previousInvocation === undefined) delete process.env.JINGLER_GIT_INVOCATION
      else process.env.JINGLER_GIT_INVOCATION = previousInvocation
    }
  })
})
