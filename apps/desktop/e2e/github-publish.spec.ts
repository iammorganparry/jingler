import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
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
  // Keep the fetch URL parseable as github.com while routing the actual push
  // into the hermetic repository.
  git(worktreePath, ["remote", "set-url", "origin", "https://github.com/acme/widget.git"])
  git(worktreePath, ["remote", "set-url", "--push", "origin", `file://${repoPath}`])
  git(repoPath, ["config", "receive.denyCurrentBranch", "updateInstead"])
  git(repoPath, ["config", "receive.denyNonFastForwards", "false"])
}

test("refuses detached work, then resumes an idempotent publish after restart", async ({
  launchApp
}) => {
  const first = await launchApp({
    configured: true,
    withRepo: true,
    withoutGithubCli: true,
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
  writeFileSync(join(session.worktreePath, "publish-proof.txt"), "deterministic publish\n")

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
  expect(git(session.worktreePath, ["log", "-1", "--format=%s"])).toBe(
    "chore: ship deterministic publish"
  )
  expect(git(session.worktreePath, ["rev-list", "--count", "main..HEAD"])).toBe("1")
  expect(githubServer.operations.filter((operation) => operation.startsWith("pr create"))).toHaveLength(1)

  await first.app.close()
  const restarted = await launchApp({
    configured: true,
    withRepo: true,
    withoutGithubCli: true,
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

  const recovered = sessionsAt(home)[0]!
  expect(recovered.prNumber).toBe(900)
  expect(git(repoPath, ["rev-parse", `refs/heads/${session.branch}`])).toBe(
    git(session.worktreePath, ["rev-parse", "HEAD"])
  )
  expect(githubServer.publishedPr()).toMatchObject({
    number: 900,
    head: session.branch,
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
    withoutGithubCli: true,
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
})
