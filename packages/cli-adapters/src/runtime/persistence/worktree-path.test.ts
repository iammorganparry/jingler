import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkTemp, runExit, withTempRoot } from "../../test-support.js"
import { healedWorktreePath } from "./worktree-path.js"

describe("healedWorktreePath", () => {
  let temp: ReturnType<typeof withTempRoot>
  let homes: ReturnType<typeof mkTemp>

  beforeEach(() => {
    temp = withTempRoot()
    homes = mkTemp("jingler-homes-")
  })

  afterEach(() => {
    temp.cleanup()
    homes.cleanup()
  })

  const heal = (stored: string, repo: string, worktreesDir: string) =>
    runExit(healedWorktreePath(stored, repo, worktreesDir), temp.layer)

  const realWorktree = (home: string, repo: string, slug: string): string => {
    const dir = join(homes.dir, home, "worktrees", repo, slug)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  const worktreesDirIn = (home: string) => join(homes.dir, home, "worktrees")

  it("keeps an existing worktree path", async () => {
    const stored = realWorktree("jingler", "app", "fix-auth")
    const exit = await heal(stored, "app", worktreesDirIn("jingler"))
    expect(exit).toMatchObject({ _tag: "Success", value: stored })
  })

  it("recovers after the home directory is renamed", async () => {
    const stale = join(homes.dir, "starbase", "worktrees", "app", "fix-auth")
    const actual = realWorktree("jingler", "app", "fix-auth")
    const exit = await heal(stale, "app", worktreesDirIn("jingler"))
    expect(exit).toMatchObject({ _tag: "Success", value: actual })
  })

  it("recovers when the home and repository are renamed", async () => {
    const stale = join(homes.dir, "starbase", "worktrees", "starbase", "fix-auth")
    const actual = realWorktree("jingler", "jingler", "fix-auth")
    const exit = await heal(stale, "jingler", worktreesDirIn("jingler"))
    expect(exit).toMatchObject({ _tag: "Success", value: actual })
  })

  it("does not invent a path for a deleted worktree", async () => {
    const stale = join(homes.dir, "starbase", "worktrees", "app", "deleted")
    const exit = await heal(stale, "app", worktreesDirIn("jingler"))
    expect(exit).toMatchObject({ _tag: "Success", value: stale })
  })

  it("is a no-op for an empty worktree path or repository", async () => {
    expect(await heal("", "app", worktreesDirIn("jingler")))
      .toMatchObject({ _tag: "Success", value: "" })
    const stale = join(homes.dir, "starbase", "worktrees", "app", "fix-auth")
    expect(await heal(stale, "", worktreesDirIn("jingler")))
      .toMatchObject({ _tag: "Success", value: stale })
  })
})
