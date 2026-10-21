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

test("PR stack rail orders layers base-up and ⌥] moves to the next PR with Checks following", async ({ launchApp }) => {
  const pr = (number: number, headRefName: string, baseRefName: string, check: string) => ({
    number, title: `Layer ${number}`, headRefName, baseRefName, author: { login: "e2e-user" },
    checks: [{ name: check, conclusion: "success" }]
  })
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: (context) => [{
      id: "s_stack", repo: "widget", branch: "stack/ui", title: "Stack session", status: "idle",
      diff: { added: 0, removed: 0 }, prNumber: 482, costUsd: 0, tokens: 0, updatedAt: "2026-10-12T10:00:00.000Z",
      prs: [
        { number: 480, branch: "stack/model", base: "main" },
        { number: 481, branch: "stack/api", base: "stack/model" },
        { number: 482, branch: "stack/ui", base: "stack/api" }
      ],
      githubInstallationId: "101", githubRepositoryId: "301", worktreePath: context.repoPath
    }],
    githubApp: {
      connected: true,
      userLogin: "e2e-user",
      prs: [
        pr(480, "stack/model", "main", "check-480"),
        pr(481, "stack/api", "stack/model", "check-481"),
        pr(482, "stack/ui", "stack/api", "check-482")
      ]
    }
  })
  await window.getByTestId("session-row-s_stack").click()
  await window.getByTestId("header-link-pr").click()
  await window.getByRole("tablist", { name: "Pull request sections" }).getByRole("tab", { name: /^Checks/ }).click()

  // Rail lists the layers bottom (base) first. Scoped to layer rows, not the
  // "Merge stack" CTA below them, which is also a button on this rail.
  const rail = window.getByTestId("pr-stack-rail")
  const layerButtons = rail.locator("[data-testid^='pr-stack-layer-']")
  await expect(layerButtons).toHaveCount(3)
  await expect(layerButtons.nth(0)).toContainText("#480")
  await expect(layerButtons.nth(2)).toContainText("#482")

  // The session's own PR (top of the stack) is selected first.
  await expect(window.getByTestId("pr-switcher")).toContainText("PR #482")
  await expect(window.getByTestId("pr-switcher")).toContainText("3/3")
  await expect(window.getByText("check-482").first()).toBeVisible()

  // ⌥[ goes down the stack, ⌥] back up; Checks follows the selection.
  await window.keyboard.press("Alt+BracketLeft")
  await expect(window.getByTestId("pr-switcher")).toContainText("PR #481")
  await expect(window.getByText("check-481").first()).toBeVisible()
  await window.keyboard.press("Alt+BracketLeft")
  await expect(window.getByText("check-480").first()).toBeVisible()
  await window.keyboard.press("Alt+BracketRight")
  await expect(window.getByTestId("pr-switcher")).toContainText("PR #481")
  await expect(window.getByText("check-481").first()).toBeVisible()
})

test("Merge stack CTA merges layers base-up and shows progress", async ({ launchApp }) => {
  const pr = (number: number, headRefName: string, baseRefName: string, check: string) => ({
    number, title: `Layer ${number}`, headRefName, baseRefName, author: { login: "e2e-user" },
    checks: [{ name: check, conclusion: "success" }]
  })
  const { window, githubServer } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: (context) => [{
      id: "s_merge_stack", repo: "widget", githubSlug: "acme/widget", branch: "stack/ui", title: "Stack session", status: "idle",
      diff: { added: 0, removed: 0 }, prNumber: 482, costUsd: 0, tokens: 0, updatedAt: "2026-10-12T10:00:00.000Z",
      prs: [
        { number: 480, branch: "stack/model", base: "main" },
        { number: 481, branch: "stack/api", base: "stack/model" },
        { number: 482, branch: "stack/ui", base: "stack/api" }
      ],
      githubInstallationId: "101", githubRepositoryId: "301", worktreePath: context.repoPath
    }],
    githubApp: {
      connected: true,
      userLogin: "e2e-user",
      prs: [
        pr(480, "stack/model", "main", "check-480"),
        pr(481, "stack/api", "stack/model", "check-481"),
        pr(482, "stack/ui", "stack/api", "check-482")
      ]
    }
  })
  await window.getByTestId("session-row-s_merge_stack").click()
  await window.getByTestId("header-link-pr").click()
  await window.getByRole("tablist", { name: "Pull request sections" }).getByRole("tab", { name: /^Checks/ }).click()

  await window.getByTestId("merge-stack-cta").click()

  // The run merges base-up and the fake server merges every layer.
  await expect.poll(() => githubServer.operations.filter((op) => op.startsWith("pr merge")).length, { timeout: 15_000 }).toBe(3)
  await expect(window.getByTestId("merge-stack-cta")).toHaveText("Merge stack")
})

test("Restack retargets and rebases every upper layer after the base merges", async ({ launchApp }) => {
  const pr = (number: number, headRefName: string, baseRefName: string, state: string) => ({
    number, title: `Layer ${number}`, headRefName, baseRefName, state, author: { login: "e2e-user" },
    checks: [{ name: `check-${number}`, conclusion: "success" }]
  })
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: (context) => [{
      id: "s_restack", repo: "widget", githubSlug: "acme/widget", branch: "stack/ui", title: "Stack session", status: "idle",
      diff: { added: 0, removed: 0 }, prNumber: 482, costUsd: 0, tokens: 0, updatedAt: "2026-10-12T10:00:00.000Z",
      prs: [
        { number: 480, branch: "stack/model", base: "main" },
        { number: 481, branch: "stack/api", base: "stack/model" },
        { number: 482, branch: "stack/ui", base: "stack/api" }
      ],
      githubInstallationId: "101", githubRepositoryId: "301", worktreePath: context.repoPath
    }],
    githubApp: {
      connected: true,
      userLogin: "e2e-user",
      prs: [pr(480, "stack/model", "main", "MERGED"), pr(481, "stack/api", "stack/model", "OPEN"), pr(482, "stack/ui", "stack/api", "OPEN")]
    }
  })
  await window.getByTestId("session-row-s_restack").click()
  await window.getByTestId("header-link-pr").click()
  await window.getByRole("tablist", { name: "Pull request sections" }).getByRole("tab", { name: /^Checks/ }).click()

  await expect(window.getByTestId("pr-stack-layer-481")).toContainText("Base merged")
  await expect(window.getByTestId("pr-stack-rebase-481")).toBeVisible()
  await window.getByTestId("restack-cta").click()

  // GAP: the fake GitHub cannot serve the installation-token fetch (git URL rewrites are refused), so the
  // retarget/rebase itself is covered by rpc-restack.test.ts; here we assert the action runs and settles.
  await expect(window.getByTestId("restack-cta")).toHaveText("Restack")
})

test("Merge stack merges in order; a failure stops the run and Resume continues it", async ({ launchApp }) => {
  const pr = (number: number, headRefName: string, baseRefName: string) => ({
    number, title: `Layer ${number}`, headRefName, baseRefName, author: { login: "e2e-user" },
    checks: [{ name: `check-${number}`, conclusion: "success" }]
  })
  const { window, githubServer } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: (context) => [{
      id: "s_resume", repo: "widget", githubSlug: "acme/widget", branch: "stack/ui", title: "Stack session", status: "idle",
      diff: { added: 0, removed: 0 }, prNumber: 482, costUsd: 0, tokens: 0, updatedAt: "2026-10-12T10:00:00.000Z",
      prs: [
        { number: 480, branch: "stack/model", base: "main" },
        { number: 481, branch: "stack/api", base: "stack/model" },
        { number: 482, branch: "stack/ui", base: "stack/api" }
      ],
      githubInstallationId: "101", githubRepositoryId: "301", worktreePath: context.repoPath
    }],
    githubApp: {
      connected: true,
      userLogin: "e2e-user",
      prs: [pr(480, "stack/model", "main"), pr(481, "stack/api", "stack/model"), pr(482, "stack/ui", "stack/api")]
    }
  })
  await window.getByTestId("session-row-s_resume").click()
  await window.getByTestId("header-link-pr").click()
  await window.getByRole("tablist", { name: "Pull request sections" }).getByRole("tab", { name: /^Checks/ }).click()

  await expect(window.getByTestId("pr-stack-merge-first-482")).toContainText("Merge #481 first")
  const merges = () => githubServer.operations.filter((op) => /^pr merge/.test(op))
  githubServer.failNext("merge-pr")
  await window.getByTestId("merge-stack-cta").click()

  // The base layer's merge fails: the run stops with nothing merged.
  await expect(window.getByTestId("merge-stack-resume")).toBeVisible()
  await expect(window.getByTestId("merge-stack-error")).toBeVisible()
  expect(merges()).toHaveLength(0)

  await window.getByTestId("merge-stack-resume").click()
  await expect.poll(() => merges(), { timeout: 15_000 }).toEqual(["pr merge 480 --merge", "pr merge 481 --merge", "pr merge 482 --merge"])
})
