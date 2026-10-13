import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { appShell, createWorkspace, expect, sessionRow, test } from "./fixtures.js"

const git = (cwd: string, args: ReadonlyArray<string>): string =>
  execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim()

test("Create PR shows the Base selector and publishes against the chosen base", async ({ launchApp }) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    config: {
      github: { enabled: true, autoCreatePr: false, autoDetectPr: false }
    },
    githubApp: { connected: true, userLogin: "e2e-user", accountLogin: "acme" }
  })
  const { window, home, repoPath, githubServer } = launched

  await expect(appShell(window)).toBeVisible()
  await createWorkspace(window, "First layer", "worktree", repoPath)

  // Create and publish the first layer
  const composer = window.getByPlaceholder("Message the agent…")
  await composer.fill("Build first feature layer")
  await composer.press("Enter")
  
  const sessions = JSON.parse(
    readFileSync(join(home, "jingler", "sessions.json"), "utf8")
  )
  const session1 = sessions[0]
  const worktree1 = session1.worktreePath

  git(repoPath, ["remote", "set-url", "origin", "git@github.com:acme/widget.git"])
  git(repoPath, ["remote", "set-url", "--push", "origin", `file://${repoPath}-wrong`])
  git(repoPath, ["config", `url.file://${repoPath}.insteadOf`, "https://github.com/acme/widget.git"])
  git(repoPath, ["config", "receive.denyCurrentBranch", "updateInstead"])
  git(repoPath, ["config", "receive.denyNonFastForwards", "false"])
  
  git(worktree1, ["remote", "set-url", "origin", "git@github.com:acme/widget.git"])
  git(worktree1, ["remote", "set-url", "--push", "origin", `file://${repoPath}-wrong`])
  git(worktree1, ["config", `url.file://${repoPath}.insteadOf`, "https://github.com/acme/widget.git"])

  writeFileSync(join(worktree1, "layer1.txt"), "first layer\n")

  await expect.poll(() => {
    const s = JSON.parse(readFileSync(join(home, "jingler", "sessions.json"), "utf8"))
    return s[0]?.semanticBranchPending
  }, { timeout: 25_000 }).toBe(false)

  await window.getByTestId("header-view-checks").click()
  // No stack yet: the Base selector defaults to the session's base branch.
  await expect(window.getByLabel("Select base branch for pull request")).toContainText("main")
  await window.getByRole("button", { name: /publish pull request/i }).click()
  
  await expect.poll(() => {
    const s = JSON.parse(readFileSync(join(home, "jingler", "sessions.json"), "utf8"))
    return s[0]?.publish?.step
  }, { timeout: 25_000 }).toBe("complete")

  const pr1 = githubServer.publishedPr()
  expect(pr1).toMatchObject({
    number: 900,
    base: "main",
    head: expect.stringMatching(/^acme:/)
  })
})
