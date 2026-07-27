import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { cliProjectSlug, healedWorktreePath, migrateCliProjectDir } from "./cli-project-dir.js"
import { mkTemp, runExit, withTempRoot } from "./test-support.js"

/**
 * The slug rule belongs to Claude Code, not to Jingler. These cases are the
 * observations that pinned it — each one taken from a real directory on a
 * machine with 169 of them, so a future change to the rule fails here rather
 * than silently migrating nothing.
 */
describe("cliProjectSlug", () => {
  it("turns path separators into dashes", () => {
    expect(cliProjectSlug("/Users/me/jingler/worktrees/app/fix-auth")).toBe(
      "-Users-me-jingler-worktrees-app-fix-auth"
    )
  })

  it("collapses a dot-directory into a DOUBLE dash", () => {
    // The slash and the dot each contribute one. Getting this wrong is invisible
    // until a session runs somewhere like `<repo>/.claude/worktrees/...`.
    expect(cliProjectSlug("/Users/me/.config")).toBe("-Users-me--config")
  })

  it("dashes a literal space", () => {
    expect(cliProjectSlug("/Applications/GTM Grid.app")).toBe("-Applications-GTM-Grid-app")
  })

  it("preserves case", () => {
    expect(cliProjectSlug("/Users/Me/Repos/MyApp")).toBe("-Users-Me-Repos-MyApp")
  })

  it("keeps existing dashes as they are", () => {
    expect(cliProjectSlug("/a/trigify-app.feat-signal")).toBe("-a-trigify-app-feat-signal")
  })
})

describe("migrateCliProjectDir", () => {
  let temp: ReturnType<typeof withTempRoot>
  let projects: ReturnType<typeof mkTemp>
  beforeEach(() => {
    temp = withTempRoot()
    projects = mkTemp("claude-projects-")
  })
  afterEach(() => {
    temp.cleanup()
    projects.cleanup()
  })

  const OLD = "/Users/me/starbase/worktrees/app/fix-auth"
  const NEW = "/Users/me/jingler/worktrees/app/fix-auth"

  /** Seed a project dir for `path` holding the named transcripts. */
  const seed = (path: string, files: Record<string, string>): string => {
    const dir = join(projects.dir, cliProjectSlug(path))
    mkdirSync(dir, { recursive: true })
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
    return dir
  }

  const migrate = (from: string, to: string) =>
    runExit(migrateCliProjectDir(from, to, projects.dir), temp.layer)

  const dirFor = (path: string) => join(projects.dir, cliProjectSlug(path))

  it("re-files transcripts under the new path's slug", async () => {
    seed(OLD, { "abc.jsonl": "conversation" })

    const exit = await migrate(OLD, NEW)
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    expect(exit.value).toBe(true)

    expect(existsSync(dirFor(OLD))).toBe(false)
    expect(readFileSync(join(dirFor(NEW), "abc.jsonl"), "utf-8")).toBe("conversation")
  })

  it("carries nested subagent transcripts across", async () => {
    // A rename moves the whole subtree without this code having to know that
    // `subagents/` exists — which it should not have to.
    const dir = seed(OLD, { "abc.jsonl": "root" })
    mkdirSync(join(dir, "abc", "subagents"), { recursive: true })
    writeFileSync(join(dir, "abc", "subagents", "agent-1.jsonl"), "sub")

    await migrate(OLD, NEW)

    expect(readFileSync(join(dirFor(NEW), "abc", "subagents", "agent-1.jsonl"), "utf-8")).toBe("sub")
  })

  it("merges into an existing destination without overwriting its history", async () => {
    seed(OLD, { "shared.jsonl": "from the old path", "only-old.jsonl": "old" })
    seed(NEW, { "shared.jsonl": "ALREADY HERE" })

    const exit = await migrate(OLD, NEW)
    expect(exit._tag).toBe("Success")

    // The destination's own copy wins — a merge may add history, never replace it.
    expect(readFileSync(join(dirFor(NEW), "shared.jsonl"), "utf-8")).toBe("ALREADY HERE")
    expect(readFileSync(join(dirFor(NEW), "only-old.jsonl"), "utf-8")).toBe("old")
    // The collided file is still in the source rather than deleted, so nothing
    // is lost even in the case we declined to resolve.
    expect(readFileSync(join(dirFor(OLD), "shared.jsonl"), "utf-8")).toBe("from the old path")
  })

  it("does nothing when there is no old directory", async () => {
    const exit = await migrate(OLD, NEW)
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    expect(exit.value).toBe(false)
    expect(existsSync(dirFor(NEW))).toBe(false)
  })

  it("is a no-op when the path did not actually change", async () => {
    seed(OLD, { "abc.jsonl": "conversation" })
    const exit = await migrate(OLD, OLD)
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    expect(exit.value).toBe(false)
    expect(readFileSync(join(dirFor(OLD), "abc.jsonl"), "utf-8")).toBe("conversation")
  })

  it("is a no-op for empty paths", async () => {
    for (const [a, b] of [
      ["", NEW],
      [OLD, ""]
    ] as const) {
      const exit = await migrate(a, b)
      expect(exit._tag).toBe("Success")
      if (exit._tag === "Success") expect(exit.value).toBe(false)
    }
  })

  it("is idempotent — running it twice leaves the same result", async () => {
    seed(OLD, { "abc.jsonl": "conversation" })
    await migrate(OLD, NEW)
    const second = await migrate(OLD, NEW)
    expect(second._tag).toBe("Success")
    if (second._tag !== "Success") return
    expect(second.value).toBe(false)
    expect(readFileSync(join(dirFor(NEW), "abc.jsonl"), "utf-8")).toBe("conversation")
  })
})

/**
 * The stale-path recovery. `Session.worktreePath` is stored absolute and nothing
 * rewrites it, so renaming `~/jingler` (which this app's own rename did, with no
 * migration) leaves every session pointing at a directory that is not there.
 */
describe("healedWorktreePath", () => {
  let temp: ReturnType<typeof withTempRoot>
  let projects: ReturnType<typeof mkTemp>
  let homes: ReturnType<typeof mkTemp>
  beforeEach(() => {
    temp = withTempRoot()
    projects = mkTemp("claude-projects-")
    homes = mkTemp("jingler-homes-")
  })
  afterEach(() => {
    temp.cleanup()
    projects.cleanup()
    homes.cleanup()
  })

  const heal = (stored: string, repo: string, worktreesDir: string) =>
    runExit(healedWorktreePath(stored, repo, worktreesDir, projects.dir), temp.layer)

  /** A worktree that really exists under `<homes>/<home>/worktrees/<repo>/<slug>`. */
  const realWorktree = (home: string, repo: string, slug: string): string => {
    const dir = join(homes.dir, home, "worktrees", repo, slug)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  const worktreesDirIn = (home: string) => join(homes.dir, home, "worktrees")

  it("returns the stored path untouched when it still exists", async () => {
    const stored = realWorktree("jingler", "app", "fix-auth")
    const exit = await heal(stored, "app", worktreesDirIn("jingler"))
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    expect(exit.value).toBe(stored)
  })

  it("re-points a session after the HOME directory was renamed, moving its transcripts", async () => {
    // What the starbase -> jingler rename actually did: the home moved, the
    // stored path did not, and the CLI's transcripts stayed under the old slug.
    const stale = join(homes.dir, "starbase", "worktrees", "app", "fix-auth")
    const actual = realWorktree("jingler", "app", "fix-auth")
    mkdirSync(join(projects.dir, cliProjectSlug(stale)), { recursive: true })
    writeFileSync(join(projects.dir, cliProjectSlug(stale), "abc.jsonl"), "history")

    const exit = await heal(stale, "app", worktreesDirIn("jingler"))
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    expect(exit.value).toBe(actual)

    // The transcripts moved with it — which is the whole point: without this the
    // path is right and `--resume` still finds nothing.
    expect(
      readFileSync(join(projects.dir, cliProjectSlug(actual), "abc.jsonl"), "utf-8")
    ).toBe("history")
  })

  it("recovers when the home AND the repo were both renamed", async () => {
    // `repo` is already re-derived from `repoPath` by `migrateRepoName`, so the
    // live name composes with the live worktrees dir even though the stored path
    // agrees with neither.
    const stale = join(homes.dir, "starbase", "worktrees", "starbase", "fix-auth")
    const actual = realWorktree("jingler", "jingler", "fix-auth")

    const exit = await heal(stale, "jingler", worktreesDirIn("jingler"))
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    expect(exit.value).toBe(actual)
  })

  it("leaves a genuinely deleted worktree alone", async () => {
    // Nothing at the expected location either: this worktree is missing, not
    // moved. Inventing a path would turn a clear failure into a confusing one.
    const stale = join(homes.dir, "starbase", "worktrees", "app", "deleted")
    const exit = await heal(stale, "app", worktreesDirIn("jingler"))
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    expect(exit.value).toBe(stale)
  })

  it("is a no-op for an empty stored path or repo", async () => {
    expect((await heal("", "app", worktreesDirIn("jingler")) as { value: string }).value).toBe("")
    const stale = join(homes.dir, "starbase", "worktrees", "app", "fix-auth")
    const exit = await heal(stale, "", worktreesDirIn("jingler"))
    if (exit._tag === "Success") expect(exit.value).toBe(stale)
  })
})
