import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import { join } from "node:path"
import { appShell, expect, sessionRow, test } from "./fixtures.js"

const FRIENDLY_WORKTREE_RE = /[\\/][a-z]+-[a-z]+$/

/**
 * The full ⌘N create-session flow, end to end against real git: open the dialog,
 * name the session, pick a base branch, hit Create, and verify the real outcomes
 * — the session shows in the sidebar, a real worktree + `jingler/<slug>` branch
 * were created, and the session was persisted to sessions.json.
 */
test("creating a session forks a real worktree and persists it", async ({ launchApp }) => {
  const { window, home, repoPath } = await launchApp({ configured: true, withRepo: true })

  // Wait for the configured shell, then open the New Session dialog.
  await expect(appShell(window)).toBeVisible()
  await window.getByTestId("new-session").click()
  await expect(window.getByRole("heading", { name: "New session" })).toBeVisible()

  // Creating a session needs an installed coding CLI (real host discovery). Skip
  // cleanly on a host with none — this is a local, non-CI flow.
  const noHarness = await window.getByText("No coding CLI found", { exact: false }).count()
  test.skip(noHarness > 0, "no coding CLI installed on this host")

  // Naming is optional. Supplying one pins the title and creates the accurate
  // readable branch immediately; blank sessions take the agent-naming path.
  await window.getByPlaceholder("Leave blank for agent naming").fill("Fix token refresh")
  const create = window.getByRole("button", { name: "Create" })
  await expect(create).toBeEnabled()
  await create.click()

  await expect(sessionRow(window, "Fix token refresh")).toBeVisible()

  // Real outcome: the trimmed operator title is pinned and its branch is
  // readable immediately.
  const persisted = JSON.parse(readFileSync(join(home, "jingler", "sessions.json"), "utf-8"))
  expect(persisted).toHaveLength(1)
  expect(persisted[0]).toMatchObject({
    title: "Fix token refresh",
    repo: "widget",
    status: "idle",
    autoTitle: false
  })
  expect(persisted[0].branch).toMatch(/^jingler\/fix-token-refresh-[a-z0-9]+$/)

  // Real outcome: that branch + worktree actually exist on disk.
  expect(existsSync(persisted[0].worktreePath)).toBe(true)
  const branches = execFileSync("git", ["branch", "--format=%(refname:short)"], {
    cwd: repoPath,
    encoding: "utf-8"
  })
  expect(branches).toContain(persisted[0].branch)
})

/**
 * Blank creation takes the staging path the agent later names: the session is
 * persisted as auto-titled, but its friendly-named worktree remains detached at
 * the selected base until the first generated task title activates a branch.
 */
test("creating a blank session stages a detached worktree for agent naming", async ({
  launchApp
}) => {
  const { window, home } = await launchApp({ configured: true, withRepo: true })

  await expect(appShell(window)).toBeVisible()
  await window.getByTestId("new-session").click()
  await expect(window.getByRole("heading", { name: "New session" })).toBeVisible()

  const noHarness = await window.getByText("No coding CLI found", { exact: false }).count()
  test.skip(noHarness > 0, "no coding CLI installed on this host")

  // Leave Name blank: this is the agent-naming fallback, not the explicit-title
  // branch path exercised above.
  await expect(window.getByPlaceholder("Leave blank for agent naming")).toHaveValue("")
  const create = window.getByRole("button", { name: "Create" })
  await expect(create).toBeEnabled()
  await create.click()

  await expect(sessionRow(window, "Untitled session")).toBeVisible()

  const persisted = JSON.parse(
    readFileSync(join(home, "jingler", "sessions.json"), "utf-8")
  )
  expect(persisted).toHaveLength(1)
  expect(persisted[0]).toMatchObject({
    title: "Untitled session",
    autoTitle: true,
    branch: "main",
    baseBranch: "main",
    repo: "widget",
    status: "idle",
    prNumber: null
  })
  expect(persisted[0].worktreePath).toMatch(FRIENDLY_WORKTREE_RE)
  expect(existsSync(persisted[0].worktreePath)).toBe(true)

  const liveBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: persisted[0].worktreePath,
    encoding: "utf-8"
  }).trim()
  expect(liveBranch).toBe("HEAD")
})

test("creating without a worktree uses the selected repository checkout", async ({
  launchApp
}) => {
  const { window, home, repoPath } = await launchApp({
    configured: true,
    withRepo: true
  })

  await expect(appShell(window)).toBeVisible()
  await window.getByTestId("new-session").click()
  const worktree = window.getByRole("switch", { name: "Use isolated worktree" })
  await expect(worktree).toBeChecked()

  // OPEN always restores the safe default, even after an abandoned direct-mode
  // draft. The second opening is the one we submit.
  await worktree.click()
  await expect(worktree).not.toBeChecked()
  await window.getByRole("button", { name: "Cancel" }).click()
  await window.getByTestId("new-session").click()
  await expect(worktree).toBeChecked()

  await worktree.click()
  await expect(
    window.getByText(
      "The agent shares this repository checkout and works directly on the selected branch."
    )
  ).toBeVisible()
  await window
    .getByPlaceholder("Leave blank for agent naming")
    .fill("Work in the checkout")
  await window.getByRole("button", { name: "Create" }).click()

  await expect(sessionRow(window, "Work in the checkout")).toBeVisible()
  const persisted = JSON.parse(
    readFileSync(join(home, "jingler", "sessions.json"), "utf-8")
  )
  expect(persisted).toHaveLength(1)
  expect(persisted[0]).toMatchObject({
    title: "Work in the checkout",
    branch: "main",
    baseBranch: "main",
    workspaceMode: "direct"
  })
  expect(persisted[0].worktreePath).toBe(persisted[0].repoPath)
  expect(statSync(persisted[0].worktreePath).ino).toBe(statSync(repoPath).ino)

  const registrations = execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd: repoPath,
    encoding: "utf-8"
  })
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
  expect(registrations).toEqual([`worktree ${realpathSync(repoPath)}`])
  const branches = execFileSync("git", ["branch", "--format=%(refname:short)"], {
    cwd: repoPath,
    encoding: "utf-8"
  })
  expect(branches).not.toContain("jingler/")
})

test("a new session inherits the preferred orchestrator harness, model, and chat role", async ({
  launchApp
}) => {
  const { window, home } = await launchApp({
    configured: true,
    withRepo: true,
    config: {
      orchestrator: { cli: "codex", model: "gpt-5.6-sol" }
    }
  })

  await expect(appShell(window)).toBeVisible()
  await window.getByTestId("new-session").click()
  await window.getByPlaceholder("Leave blank for agent naming").fill("Orchestrated task")
  await window.getByRole("button", { name: "Create" }).click()
  await expect(sessionRow(window, "Orchestrated task")).toBeVisible()

  const persisted = JSON.parse(
    readFileSync(join(home, "jingler", "sessions.json"), "utf-8")
  )
  expect(persisted[0]).toMatchObject({
    cli: "codex",
    chats: [
      {
        role: "orchestrator",
        model: "gpt-5.6-sol"
      }
    ]
  })
})

/**
 * The "new session from an existing PR" flow, end to end against real git with a
 * deterministic fake `gh`: toggle the dialog to "From PR", pick an open PR, hit
 * Create, and verify the session was created ON the PR's head branch and linked
 * to its number (so the sidebar badge + PR tabs light up).
 */
test("creating a session from a PR checks out its head branch and links the PR", async ({
  launchApp
}) => {
  const { window, home } = await launchApp({
    configured: true,
    withRepo: true,
    gh: {
      login: "e2e-user",
      prs: [
        {
          number: 482,
          title: "Fix auth refresh race",
          headRefName: "chore/bump",
          baseRefName: "main",
          author: { login: "octocat" },
          additions: 31,
          deletions: 4
        },
        {
          number: 471,
          title: "Add usage window",
          headRefName: "feat/usage",
          baseRefName: "main",
          author: { login: "hubot" }
        }
      ]
    }
  })

  await expect(appShell(window)).toBeVisible()
  await window.getByTestId("new-session").click()
  await expect(window.getByRole("heading", { name: "New session" })).toBeVisible()

  // From-PR creation still needs an installed harness to drive the session.
  const noHarness = await window.getByText("No coding CLI found", { exact: false }).count()
  test.skip(noHarness > 0, "no coding CLI installed on this host")

  // The fake gh reports authenticated, so the "From PR" toggle is available.
  await window.getByRole("tab", { name: "From PR" }).click()

  // The picker chrome + the seeded open PRs render.
  await expect(window.getByPlaceholder("Search open pull requests…")).toBeVisible()
  await expect(window.getByText("Just mine")).toBeVisible()
  await expect(window.getByText("Fix auth refresh race")).toBeVisible()
  await expect(window.getByText("#482")).toBeVisible()

  // Select PR #482 → Create enables → create the session.
  await window.getByText("Fix auth refresh race").click()
  const create = window.getByRole("button", { name: "Create" })
  await expect(create).toBeEnabled()
  await create.click()

  // Wait for creation to complete: the dialog closes and the new session's PR
  // badge (`⑂ #482`, only in the sidebar) appears. Only then is the worktree on disk.
  await expect(window.getByRole("heading", { name: "New session" })).toBeHidden()
  await expect(window.getByText("⑂ #482")).toBeVisible()

  // Real outcome: the worktree is on the PR's head branch (not a jingler/ fork).
  // The from-PR slug carries the PR number, so same-titled PRs never collide.
  const worktreePath = join(home, "jingler", "worktrees", "widget", "fix-auth-refresh-race-482")
  expect(existsSync(worktreePath)).toBe(true)
  const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: worktreePath,
    encoding: "utf-8"
  }).trim()
  expect(branch).toBe("chore/bump")

  // Real outcome: the session is persisted with the PR linked.
  const persisted = JSON.parse(readFileSync(join(home, "jingler", "sessions.json"), "utf-8"))
  expect(persisted).toHaveLength(1)
  expect(persisted[0]).toMatchObject({
    title: "Fix auth refresh race",
    branch: "chore/bump",
    baseBranch: "main",
    prNumber: 482,
    repo: "widget"
  })
})

/**
 * The "new session from a GitHub issue" flow, end to end against real git with a
 * deterministic fake `gh issue list`: toggle to "From issue", pick an open issue,
 * advance to the prefill step, create — and verify the session was forked onto a
 * fresh `jingler/<n>-slug` branch, linked to the issue, with the task seeded from
 * the issue and the automations persisted.
 */
test("creating a session from an issue forks a linked branch and seeds the task", async ({
  launchApp
}) => {
  const { window, home, repoPath } = await launchApp({
    configured: true,
    withRepo: true,
    gh: {
      login: "e2e-user",
      issues: [
        {
          number: 128,
          title: "Refund route 500s on a stale token",
          body: "Fix the refund route so a stale token triggers a refresh + retry.",
          labels: [{ name: "bug", color: "e06c75" }],
          author: { login: "mira" },
          assignees: [{ login: "dan" }]
        },
        { number: 126, title: "Rate-limit the webhook ingest", author: { login: "mira" } }
      ]
    }
  })

  await expect(appShell(window)).toBeVisible()
  await window.getByTestId("new-session").click()
  await expect(window.getByRole("heading", { name: "New session" })).toBeVisible()

  const noHarness = await window.getByText("No coding CLI found", { exact: false }).count()
  test.skip(noHarness > 0, "no coding CLI installed on this host")

  // Toggle to "From issue" → the seeded open issues render.
  await window.getByRole("tab", { name: "From issue" }).click()
  await expect(window.getByPlaceholder("Search open issues…")).toBeVisible()
  await expect(window.getByText("Refund route 500s on a stale token")).toBeVisible()
  await expect(window.getByText("#128")).toBeVisible()

  // Select issue #128 → advance to the prefill step ("Start on #128").
  await window.getByText("Refund route 500s on a stale token").click()
  const start = window.getByRole("button", { name: "Start on #128" })
  await expect(start).toBeEnabled()
  await start.click()

  // The prefill step shows the editable task textarea, seeded from the issue.
  await expect(window.getByRole("textbox")).toHaveValue(/Fix the refund route/)

  // Create the session.
  const create = window.getByRole("button", { name: "Create session" })
  await expect(create).toBeEnabled()
  await create.click()

  // The dialog closes and the sidebar shows the linked-issue badge (◉ #128).
  await expect(window.getByRole("heading", { name: "New session" })).toBeHidden()
  await expect(window.getByText("◉ #128")).toBeVisible()

  // The composer is prefilled (HITL) with the task derived from the issue.
  await expect(window.getByPlaceholder("Message Claude…")).toHaveValue(/Fix the refund route/)

  // The session gains an "Issue" tab, gated on `hasIssue`.
  //
  // It is contributed by the OFFICIAL `github-issues` PLUGIN now, not by a
  // built-in pane — `8ca3351` retired the built-in one, which is the point of
  // shipping that plugin as the reference example. So the assertions that used to
  // read the rich issue view (heading, body, state) are gone: rendering it means
  // fetching from GitHub through a consent-gated `getSession("github", …)`, and an
  // offline e2e has no account to grant and no prompt to answer.
  //
  // What is still this test's business — that linking an issue makes the tab
  // appear at all — is asserted here. The plugin's own body is covered in
  // `plugins.spec.ts`, against a plugin whose host half the test controls.
  await expect(window.getByRole("button", { name: "Issue" })).toBeVisible({ timeout: 15_000 })
  await window.getByRole("button", { name: "Issue" }).click()

  // The plugin's view MOUNTED. Not "the issue rendered": fetching it needs a
  // consent-gated GitHub session, so offline the plugin correctly shows its own
  // "couldn't be loaded" state instead. Either way the assertion that matters is
  // that no plugin ERROR BOUNDARY fired — the tab is the plugin's, drawn by the
  // plugin, through the same path a third-party tab would take.
  // No plugin error boundary. That is the whole claim, and it is a real one: the
  // official plugin's tab used to die here with `jsxDEV is not a function`,
  // because the `react/jsx-dev-runtime` shim exported a name the runtime did not
  // supply. Which of the plugin's own states it then shows depends on whether a
  // GitHub session exists, so that is asserted where the fetch can be controlled
  // rather than guessed at here.
  await expect(window.getByTestId("plugin-error-github-issues")).toHaveCount(0)
  await expect(window.getByRole("button", { name: "Issue" })).toBeVisible()

  // Real outcome: a fresh `jingler/128-<slug>` worktree exists on that branch.
  const worktreePath = join(
    home,
    "jingler",
    "worktrees",
    "widget",
    "128-refund-route-500s-on-a-stale-token"
  )
  expect(existsSync(worktreePath)).toBe(true)
  const branches = execFileSync("git", ["branch", "--format=%(refname:short)"], {
    cwd: repoPath,
    encoding: "utf-8"
  })
  expect(branches).toContain("jingler/128-refund-route-500s-on-a-stale-token")

  // Real outcome: the session is persisted with the issue linked + task seeded.
  const persisted = JSON.parse(readFileSync(join(home, "jingler", "sessions.json"), "utf-8"))
  expect(persisted).toHaveLength(1)
  expect(persisted[0]).toMatchObject({
    title: "Refund route 500s on a stale token",
    branch: "jingler/128-refund-route-500s-on-a-stale-token",
    baseBranch: "main",
    issueNumber: 128,
    issueUrl: "https://github.com/acme/widget/issues/128",
    repo: "widget",
    automations: { progressComments: true, closeOnMerge: true }
  })
  // `initialPrompt` is one-shot but survives until the operator actually SENDS —
  // it is NOT cleared on mount. This test visits the Issue tab above, which is
  // exactly the case that broke: unmounting the pane discarded the composer's
  // seeded text, and a clear-on-mount left nothing to re-seed it from. So the seed
  // is still persisted here, and the composer still shows it after coming back.
  expect(persisted[0].initialPrompt).toContain("Fix the refund route")
  await window.getByRole("button", { name: "Conversation" }).click()
  await expect(window.getByPlaceholder("Message Claude…")).toHaveValue(/Fix the refund route/)

  // Sending consumes it — only then is it cleared, so re-opening never re-seeds.
  await window.getByPlaceholder("Message Claude…").press("Enter")
  await expect
    .poll(
      () =>
        JSON.parse(readFileSync(join(home, "jingler", "sessions.json"), "utf-8"))[0].initialPrompt,
      { timeout: 15_000 }
    )
    .toBeUndefined()
})
