import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { appShell, expect, sessionRow, test } from "./fixtures.js"

const git = (cwd: string, args: ReadonlyArray<string>, home?: string): string =>
  execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: home ? { ...process.env, HOME: home } : process.env
  }).trim()

interface PersistedPublishSession {
  readonly branch: string
  readonly worktreePath: string
  readonly prNumber: number | null
  readonly semanticBranchProposal?: { readonly type: string; readonly slug: string }
  readonly semanticBranchPending?: boolean
  readonly publish?: {
    readonly step: string
    readonly resumeFrom?: string
    readonly prNumber?: number
  }
}

const sessionsAt = (home: string): ReadonlyArray<PersistedPublishSession> =>
  JSON.parse(readFileSync(join(home, "jingler", "sessions.json"), "utf8")) as ReadonlyArray<PersistedPublishSession>

const prepareHermeticPush = (worktreePath: string, repoPath: string): void => {
  // The fetch remote remains SSH and its push URL is deliberately unusable.
  // Only the API-derived canonical HTTPS URL can reach the hermetic target.
  git(worktreePath, ["remote", "set-url", "origin", "git@github.com:acme/widget.git"])
  git(worktreePath, ["remote", "set-url", "--push", "origin", `file://${repoPath}-wrong-origin`])
  git(worktreePath, [
    "config",
    `url.file://${repoPath}.insteadOf`,
    "https://github.com/acme/widget.git"
  ])
  git(repoPath, ["config", "receive.denyCurrentBranch", "updateInstead"])
  git(repoPath, ["config", "receive.denyNonFastForwards", "false"])
}

test("refuses detached work, then resumes an idempotent publish after restart", async ({
  launchApp
}) => {
  const first = await launchApp({
    configured: true,
    withRepo: true,
    config: {
      github: { enabled: true, autoCreatePr: false, autoDetectPr: false }
    },
    githubApp: { connected: true, userLogin: "e2e-user", accountLogin: "acme" }
  })
  const { window, home, repoPath, githubServer } = first

  await expect(appShell(window)).toBeVisible()
  await window.getByTestId("new-session").click()
  await window.getByPlaceholder("Leave blank for agent naming").fill("Ship deterministic publish")
  await window.getByRole("button", { name: "Create" }).click()
  await expect(sessionRow(window, "Ship deterministic publish")).toBeVisible()

  // A fresh task is detached until the first understanding/retitle pass. The
  // real RPC must persist an actionable failure without staging or touching
  // GitHub, even if the user asks to publish immediately.
  await window.getByRole("button", { name: "Pull Request" }).click()
  await window.getByRole("button", { name: "Publish pull request" }).click()
  await expect(window.getByText("Publishing stopped")).toBeVisible()
  await expect(window.getByText(/Finish creating the semantic task branch/)).toBeVisible()
  expect(githubServer.operations).toEqual([])
  await expect.poll(() => sessionsAt(home)[0]?.publish?.step).toBe("failed")
  expect(sessionsAt(home)[0]?.publish).toMatchObject({
    step: "failed",
    resumeFrom: "verifying-branch"
  })

  await window.getByRole("button", { name: "Chat 1", exact: true }).click()
  const composer = window.getByPlaceholder("Message Claude…")
  await composer.fill("Implement deterministic publishing")
  await composer.press("Enter")
  await expect(window.getByText("1 passed")).toBeVisible({ timeout: 25_000 })
  await expect.poll(() => sessionsAt(home)[0]?.semanticBranchPending).toBe(false)

  const session = sessionsAt(home)[0]!
  expect(session.branch).toMatch(/^chore\//)
  prepareHermeticPush(session.worktreePath, repoPath)
  mkdirSync(join(session.worktreePath, ".github", "workflows"), { recursive: true })
  writeFileSync(
    join(session.worktreePath, ".github", "workflows", "publish.yml"),
    "name: Publish proof\n"
  )

  // Create succeeds, but the following description update fails once. This is
  // the awkward partial-success boundary: a restart must discover PR #900 and
  // continue without manufacturing another commit or PR.
  githubServer.failNext("update-pr")
  await window.getByRole("button", { name: "Pull Request" }).click()
  await expect(window.getByText(`Branch: ${session.branch}`)).toBeVisible()
  await window.getByRole("button", { name: /publishing again/i }).dblclick()
  await expect(window.getByText("Publishing stopped")).toBeVisible({ timeout: 25_000 })
  await expect(window.getByText("Update pull request description")).toBeVisible()
  await expect.poll(() => sessionsAt(home)[0]?.publish?.step).toBe("failed")
  expect(sessionsAt(home)[0]?.publish).toMatchObject({
    resumeFrom: "updating-pr",
    prNumber: 900
  })
  expect(githubServer.requests).toContainEqual({
    method: "POST",
    path: "/api/github/session-routes"
  })
  expect(git(session.worktreePath, ["log", "-1", "--format=%s"])).toBe(
    "chore: implement deterministic publishing"
  )
  expect(git(session.worktreePath, ["rev-list", "--count", "main..HEAD"])).toBe("1")
  expect(githubServer.operations.filter((operation) => operation.startsWith("pr create"))).toHaveLength(1)
  expect(git(session.worktreePath, ["remote", "get-url", "origin"]))
    .toBe("git@github.com:acme/widget.git")
  expect(git(session.worktreePath, ["remote", "get-url", "--push", "origin"]))
    .toBe(`file://${repoPath}-wrong-origin`)
  expect(githubServer.credentialRequests).toContainEqual({
    repository: "acme/widget",
    permissions: ["contents:write", "workflows:write"]
  })

  await first.app.close()
  const restarted = await launchApp({
    configured: true,
    withRepo: true,
    home: first.home,
    reposDir: first.reposDir,
    userDataDir: first.userDataDir,
    authServer: first.authServer,
    githubServer: first.githubServer,
    githubRelay: first.githubRelay,
    githubApp: { connected: true }
  })

  await expect(appShell(restarted.window)).toBeVisible()
  await sessionRow(restarted.window, "Ship deterministic publish").click()
  await restarted.window.getByRole("button", { name: "Pull Request" }).click()
  await expect(restarted.window.getByText("Publishing stopped")).toBeVisible()
  await restarted.window.getByRole("button", { name: /Retry from updating-pr/ }).click()
  await expect.poll(() => sessionsAt(home)[0]?.publish?.step, { timeout: 25_000 }).toBe("complete")
  await expect(restarted.window.getByRole("heading", { name: "Ship deterministic publish" })).toBeVisible()
  await expect(
    restarted.window.getByRole("button", { name: "Open on GitHub ↗" })
  ).toBeVisible()

  const recovered = sessionsAt(home)[0]!
  expect(recovered.prNumber).toBe(900)
  expect(git(repoPath, ["rev-parse", `refs/heads/${session.branch}`])).toBe(
    git(session.worktreePath, ["rev-parse", "HEAD"])
  )
  expect(githubServer.publishedPr()).toMatchObject({
    number: 900,
    head: `acme:${session.branch}`,
    base: "main",
    title: "Ship deterministic publish"
  })
  expect(githubServer.publishedPr()?.body).toContain("## Summary")
  expect(githubServer.operations.filter((operation) => operation.startsWith("pr create"))).toHaveLength(1)
  expect(githubServer.operations.filter((operation) => operation === "pr update 900")).toHaveLength(1)
})

test("auto-create preference uses the same semantic publish flow", async ({ launchApp }) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    config: {
      github: { enabled: true, autoCreatePr: true, autoDetectPr: false }
    },
    githubApp: { connected: true, userLogin: "e2e-user", accountLogin: "acme" }
  })
  const { window, home, repoPath, githubServer } = launched

  await expect(appShell(window)).toBeVisible()
  await window.getByTestId("new-session").click()
  await window.getByPlaceholder("Leave blank for agent naming").fill("Publish automatically")
  await window.getByRole("button", { name: "Create" }).click()
  await expect(sessionRow(window, "Publish automatically")).toBeVisible()

  const detached = sessionsAt(home)[0]!
  prepareHermeticPush(detached.worktreePath, repoPath)
  writeFileSync(join(detached.worktreePath, "automatic-proof.txt"), "automatic publish\n")

  const composer = window.getByPlaceholder("Message Claude…")
  await composer.fill("Implement automatic publishing")
  await composer.press("Enter")
  await expect(window.getByText("1 passed")).toBeVisible({ timeout: 25_000 })
  await expect.poll(() => sessionsAt(home)[0]?.publish?.step, { timeout: 25_000 }).toBe("complete")

  const session = sessionsAt(home)[0]!
  expect(session.branch).toMatch(/^chore\//)
  expect(session.prNumber).toBe(900)
  expect(git(session.worktreePath, ["rev-list", "--count", "main..HEAD"])).toBe("1")
  expect(githubServer.operations.filter((operation) => operation.startsWith("pr create"))).toHaveLength(1)
  expect(githubServer.credentialRequests).toContainEqual({
    repository: "acme/widget",
    permissions: ["contents:write"]
  })
  expect(
    githubServer.credentialRequests.some(({ permissions }) => permissions.includes("workflows:write"))
  ).toBe(false)
})

test("publishes a migration-era established jingler branch without renaming it", async ({
  launchApp
}) => {
  const branch = "jingler/historical-publish"
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    config: {
      github: { enabled: true, autoCreatePr: false, autoDetectPr: false }
    },
    githubApp: { connected: true, userLogin: "e2e-user", accountLogin: "acme" },
    sessions: ({ repoPath, reposDir }) => [{
      id: "s_historical_publish",
      repo: "widget",
      repoPath,
      branch,
      title: "Publish historical session",
      status: "idle",
      cli: "claude",
      diff: { added: 0, removed: 0 },
      prNumber: null,
      costUsd: 0,
      tokens: 0,
      updatedAt: "2026-08-04T09:00:00.000Z",
      worktreePath: join(reposDir, "historical-publish"),
      baseBranch: "main"
    }],
    seed: ({ repoPath, reposDir }) => {
      const worktreePath = join(reposDir, "historical-publish")
      git(repoPath, ["worktree", "add", "-b", branch, worktreePath, "main"])
      writeFileSync(join(worktreePath, "historical-proof.txt"), "historical publish\n")
    }
  })
  const { window, home, repoPath, githubServer } = launched
  const historicalWorktree = sessionsAt(home)[0]!.worktreePath
  prepareHermeticPush(historicalWorktree, repoPath)

  await expect(appShell(window)).toBeVisible()
  await sessionRow(window, "Publish historical session").click()
  await window.getByRole("button", { name: "Pull Request", exact: true }).click()
  await window.getByRole("button", { name: "Publish pull request" }).click()
  await expect.poll(
    () => sessionsAt(home)[0]?.publish?.step,
    { timeout: 25_000 }
  ).toBe("complete")

  const persisted = sessionsAt(home)[0]!
  expect(persisted.branch).toBe(branch)
  expect(persisted.semanticBranchPending).toBeUndefined()
  expect(persisted.semanticBranchProposal).toBeUndefined()
  expect(git(historicalWorktree, ["rev-list", "--count", "main..HEAD"])).toBe("1")
  expect(git(historicalWorktree, ["log", "-1", "--format=%s"])).toBe(
    "chore: historical publish"
  )
  expect(githubServer.publishedPr()).toMatchObject({
    head: `acme:${branch}`,
    base: "main",
    title: "Publish historical session"
  })
})
