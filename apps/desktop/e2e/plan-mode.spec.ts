import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Page } from "@playwright/test"
import {
  appShell,
  DEFAULT_CLAUDE_MODEL,
  expect,
  planDirectory,
  type LaunchedApp,
  type SeedSession,
  test
} from "./fixtures.js"

const session = (
  cli: SeedSession["cli"] = "claude",
  id = `s_plan_${cli}`
) =>
  ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [{
    id,
    repo: "widget",
    branch: `chore/${id}`,
    title: `${cli} plan`,
    status: "idle",
    cli,
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-07-28T00:00:00.000Z",
    worktreePath: repoPath,
    mode: "accept-edits"
  }]

// Plans are structured DTOs (`PlanDocument`); the canonical file is
// `current-plan.json` (pretty-printed JSON). The document is presented read-only
// across three pages (Main / Architecture / Workflow) — there is no in-place editor.
const currentPlanPath = (launched: LaunchedApp): string =>
  join(planDirectory(launched.home, launched.repoPath), "current-plan.json")

// A valid structured plan template: a title, a Context and a Risks section, and
// one stage. Stored as a `PlanPrd` JSON document (replaces the deleted HTML template).
const PLAN_TEMPLATE = JSON.stringify(
  {
    title: "PRD: Template",
    sections: [
      { id: "context", title: "Context", blocks: [{ kind: "prose", id: "c1", text: "Why this work matters." }] },
      { id: "risks", title: "Risks", blocks: [{ kind: "prose", id: "r1", text: "Known risks." }] }
    ],
    stages: [
      {
        id: "01",
        title: "First stage",
        intent: "Do the work.",
        approach: [],
        files: [],
        diagrams: [],
        notes: [],
        acceptance: [{ id: "01.1", text: "It works.", status: "pending", evidence: null }],
        dependencies: []
      }
    ],
    annotations: []
  },
  null,
  2
)

const seedPlanAsset = ({ repoPath }: { repoPath: string }): void => {
  mkdirSync(join(repoPath, "src", "auth"), { recursive: true })
  writeFileSync(
    join(repoPath, "src", "auth", "token-store.ts"),
    "export const tokenStoreSeed = true\n"
  )
  execFileSync("git", ["add", "src/auth/token-store.ts"], { cwd: repoPath })
  execFileSync(
    "git",
    ["commit", "-m", "seed plan asset", "--no-gpg-sign"],
    { cwd: repoPath }
  )
  writeFileSync(
    join(repoPath, "src", "auth", "token-store.ts"),
    "export const tokenStoreSeed = true\nexport const tokenStoreChanged = true\n"
  )
}

const seedStageReviewAssets = ({ repoPath }: { repoPath: string }): void => {
  seedPlanAsset({ repoPath })
  writeFileSync(
    join(repoPath, "src", "auth", "session.test.ts"),
    'import { expect, it } from "vitest"\nit("keeps stage review traceable", () => expect(true).toBe(true))\n'
  )
  execFileSync("git", ["add", "src/auth/session.test.ts"], { cwd: repoPath })
  execFileSync(
    "git",
    ["commit", "-m", "seed stage review test", "--no-gpg-sign"],
    { cwd: repoPath }
  )
}

const revisionOf = (file: string): number =>
  Number(/"revision":\s*(\d+)/.exec(readFileSync(file, "utf8"))?.[1] ?? 0)

const openSettings = async (window: Page): Promise<void> => {
  await window.getByRole("button", { name: "Account menu" }).click()
  await window.getByRole("menuitem", { name: "Settings" }).click()
  await expect(window.getByRole("button", { name: "Close settings" })).toBeVisible()
}

/**
 * Propose the scripted plan and open Plan Review on its canonical revision. The
 * plan is read-only now, so this waits for the Main step outline to render a
 * seeded stage title rather than for any editor/sync indicator.
 */
const proposePlan = async (launched: LaunchedApp): Promise<void> => {
  const { window } = launched
  const composer = window.getByPlaceholder(/Message .+…/)
  await composer.fill("[[plan]] refactor auth to a TokenStore")
  await composer.press("Enter")
  const review = window.getByRole("button", { name: "Plan Review" }).first()
  await expect(review).toBeVisible({ timeout: 20_000 })
  await review.click()
  // Main is the step-based outline; a stage's title renders as its card text.
  await expect(window.getByRole("tab", { name: "Main" })).toBeVisible()
  await expect(
    window.getByText("Audit session middleware", { exact: true })
  ).toBeVisible({ timeout: 20_000 })
  await expect.poll(() => existsSync(currentPlanPath(launched))).toBe(true)
  await expect.poll(() => readFileSync(currentPlanPath(launched), "utf8")).toContain(
    '"id": "s_01"'
  )
}

const writeTaskProgressPlan = (file: string): void => {
  const current = JSON.parse(readFileSync(file, "utf8"))
  current.revision += 1
  const stage = current.plan.stages[0]
  stage.tasks = [
    { id: "s_01.task.1", text: "Trace live worker progress", status: "pending" }
  ]
  stage.notes = [
    ...(stage.notes ?? []),
    {
      kind: "prose",
      id: "hold-for-progress",
      text: "[[worker-hold]] Keep the scripted worker running after it reports progress."
    }
  ]
  writeFileSync(file, JSON.stringify(current, null, 2))
}

test("the PRD template validates, persists, and resets", async ({ launchApp }) => {
  const first = await launchApp({
    configured: true,
    withRepo: true,
    sessions: session()
  })
  await expect(appShell(first.window)).toBeVisible()
  await openSettings(first.window)
  await first.window.getByRole("button", { name: "Plan", exact: true }).click()

  const source = first.window.getByLabel("Plan template source")
  // Plan-mode templates are validated as structured plan JSON now: a non-JSON
  // fragment is rejected, and saving is blocked while it is invalid.
  await source.fill("<p>no longer HTML</p>")
  await expect(first.window.getByRole("alert")).toContainText(
    "The plan template is not valid JSON."
  )
  await expect(first.window.getByRole("button", { name: "Save template" })).toBeDisabled()

  const customised = PLAN_TEMPLATE.replace('"Risks"', '"Constraints and risks"')
  await source.fill(customised)
  await expect(
    first.window.getByText("Constraints and risks", { exact: true })
  ).toBeVisible()
  await first.window.getByRole("button", { name: "Save template" }).click()
  await expect(first.window.getByRole("button", { name: "Save template" })).toBeDisabled()
  await first.app.close()

  const reopened = await launchApp({
    home: first.home,
    reposDir: first.reposDir,
    userDataDir: first.userDataDir,
    configured: true,
    withRepo: true
  })
  await openSettings(reopened.window)
  await reopened.window.getByRole("button", { name: "Plan", exact: true }).click()
  await expect(reopened.window.getByLabel("Plan template source")).toHaveValue(
    /Constraints and risks/
  )

  await reopened.window.getByRole("button", { name: "Reset default" }).click()
  await reopened.window.getByRole("button", { name: "Save template" }).click()
  await expect(reopened.window.getByLabel("Plan template source")).not.toHaveValue(
    /Constraints and risks/
  )
})

test("the preferred orchestrator persists across restart", async ({ launchApp }) => {
  const first = await launchApp({
    configured: true,
    withRepo: true,
    sessions: session()
  })
  await expect(appShell(first.window)).toBeVisible()
  await openSettings(first.window)
  await first.window.getByRole("button", { name: "Plan", exact: true }).click()

  await first.window.getByRole("combobox", { name: "Orchestrator harness" }).click()
  await first.window.getByRole("option", { name: "Codex" }).click()
  await expect
    .poll(() =>
      JSON.parse(
        readFileSync(join(first.home, "jingler", "config.json"), "utf8")
      ).orchestrator
    )
    .toEqual({ cli: "codex", model: "gpt-5.6-sol" })
  await first.app.close()

  const reopened = await launchApp({
    home: first.home,
    reposDir: first.reposDir,
    userDataDir: first.userDataDir,
    configured: true,
    withRepo: true
  })
  await openSettings(reopened.window)
  await reopened.window.getByRole("button", { name: "Plan", exact: true }).click()
  await expect(
    reopened.window.getByRole("combobox", { name: "Orchestrator harness" })
  ).toContainText("Codex")
})

test("the Main, Architecture and Workflow pages each render their surface", async ({
  launchApp
}) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    sessions: session()
  })
  await expect(appShell(launched.window)).toBeVisible()
  await proposePlan(launched)
  const { window } = launched

  // Main: the step outline, one card per stage.
  await expect(window.getByRole("tab", { name: "Main" })).toHaveAttribute(
    "aria-selected",
    "true"
  )
  await expect(window.getByText("Open PR #482", { exact: true })).toBeVisible()

  // Architecture: prose sections + stage-owned architecture grouping. The
  // dedicated test below verifies the dynamically loaded hand-drawn SVG.
  await window.getByRole("tab", { name: "Architecture" }).click()
  await expect(
    window.getByRole("heading", { name: "Technical design" })
  ).toBeVisible()
  await expect(
    window.getByRole("region", { name: "Architecture for Audit session middleware" })
  ).toBeVisible()

  // Workflow: the dependency DAG renders each stage as a node.
  await window.getByRole("tab", { name: "Workflow" }).click()
  await expect(
    window.getByText("Audit session middleware").first()
  ).toBeVisible()

  // Back to Main leaves the outline in place.
  await window.getByRole("tab", { name: "Main" }).click()
  await expect(
    window.getByText("Audit session middleware", { exact: true })
  ).toBeVisible()
})

test("the Main and Architecture pages keep TLDR and stage architecture connected", async ({
  launchApp
}) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    sessions: session()
  })
  await expect(appShell(launched.window)).toBeVisible()
  await proposePlan(launched)
  const { window } = launched

  const stage = window.locator('[data-step-id="s_01"]')
  await expect(stage.getByText("0 of 2 completed", { exact: true })).toBeVisible()
  await expect(window.getByText("Trace the existing token path", { exact: true })).toBeVisible()
  await expect(stage.locator('.sb-mermaid [data-look="handDrawn"]').first()).toBeVisible({
    timeout: 20_000
  })

  await window.getByRole("tab", { name: "Architecture" }).click()
  await expect(window.getByRole("heading", { level: 2 }).first()).toHaveText("TL;DR")
  const architecture = window.getByRole("region", {
    name: "Architecture for Audit session middleware"
  })
  await expect(
    architecture.locator('.sb-mermaid [data-look="handDrawn"]').first()
  ).toBeVisible({ timeout: 20_000 })
  await architecture.getByRole("button", {
    name: "Open stage Audit session middleware in Main"
  }).click()

  await expect(window.getByRole("tab", { name: "Main" })).toHaveAttribute(
    "aria-selected",
    "true"
  )
  await expect(window.locator('[data-step-id="s_01"]')).toHaveAttribute("aria-pressed", "true")
})

test("acceptance tests open their referenced file and identify the named case", async ({
  launchApp
}) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    seed: seedStageReviewAssets,
    sessions: session()
  })
  await expect(appShell(launched.window)).toBeVisible()
  await proposePlan(launched)
  const { window } = launched
  const stage = window.locator('[data-step-id="s_01"]')
  const namedCases = stage.getByRole("list", {
    name: "Named test cases in src/auth/session.test.ts"
  })

  await expect(namedCases).toContainText("keeps stage review traceable")
  await stage
    .getByRole("button", { name: "Open src/auth/session.test.ts", exact: true })
    .click()

  await expect(window.getByRole("button", { name: "Files", exact: true })).toHaveAttribute(
    "aria-current",
    "page"
  )
  await expect(window.getByRole("textbox", { name: "src/auth/session.test.ts" })).toContainText(
    "keeps stage review traceable"
  )
})

test("worker task progress streams into the canonical plan review", async ({
  launchApp
}) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    config: {
      orchestrator: { cli: "codex", model: "gpt-5.6-sol" }
    }
  })
  await expect(appShell(launched.window)).toBeVisible()
  const { window, home } = launched

  await window.getByTestId("new-session").click()
  await window
    .getByPlaceholder("Leave blank for agent naming")
    .fill("Task progress orchestration")
  await window.getByRole("button", { name: "Create" }).click()

  const sessionsFile = join(home, "jingler", "sessions.json")
  await expect.poll(() => existsSync(sessionsFile), { timeout: 10_000 }).toBe(true)
  const sessions = JSON.parse(readFileSync(sessionsFile, "utf8"))
  const worktreePath = sessions[0].worktreePath as string
  const planFile = join(planDirectory(home, worktreePath), "current-plan.json")
  const composer = window.getByPlaceholder("Message Codex…")
  await composer.fill("[[plan]] refactor auth to a TokenStore")
  await composer.press("Enter")
  await expect.poll(() => existsSync(planFile), { timeout: 20_000 }).toBe(true)
  await window.getByRole("button", { name: "Plan Review" }).first().click()
  await expect(window.getByText("Audit session middleware", { exact: true })).toBeVisible({
    timeout: 20_000
  })

  writeTaskProgressPlan(planFile)
  const stageCard = window.locator('[data-step-id="s_01"]')
  await expect(stageCard.getByText("Trace live worker progress", { exact: true })).toBeVisible({
    timeout: 10_000
  })
  await expect(
    stageCard.getByRole("list", { name: "Stage tasks" }).getByText("Pending", { exact: true })
  ).toBeVisible()

  await window.getByRole("button", { name: "More plan actions" }).click()
  await window.getByRole("menuitem", { name: "Approve and auto", exact: true }).click()

  await expect(stageCard.getByText("In progress", { exact: true })).toBeVisible({
    timeout: 20_000
  })
  await expect
    .poll(() => {
      const document = JSON.parse(readFileSync(planFile, "utf8"))
      return document.plan.stages[0].tasks[0].status
    })
    .toBe("in-progress")
})

test("a comment added on a step appears and can be resolved", async ({
  launchApp
}) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    sessions: session()
  })
  await expect(appShell(launched.window)).toBeVisible()
  await proposePlan(launched)
  const { window } = launched

  // The comment layer overlays the Main outline with a per-step affordance.
  await window.getByRole("button", { name: "Comment on this step" }).first().click()
  await window.getByLabel("Add a comment…").fill("Keep rollout sequential.")
  await window.getByRole("button", { name: "Send reply" }).click()

  // The new annotation round-trips through the plan file and surfaces as a pin.
  const pin = window.getByRole("button", { name: "Comment thread" })
  await expect(pin).toBeVisible({ timeout: 10_000 })
  await pin.click()
  const thread = window.locator("[data-plan-comment-thread]")
  await expect(thread.getByText("Keep rollout sequential.")).toBeVisible()
  await expect
    .poll(() => readFileSync(currentPlanPath(launched), "utf8"))
    .toContain("Keep rollout sequential.")

  await thread.getByRole("button", { name: "Resolve" }).click()
  await expect(thread.getByText("Thread resolved")).toBeVisible()
  await expect
    .poll(() => readFileSync(currentPlanPath(launched), "utf8"))
    .toContain('"status": "resolved"')
})

test("approving executes the plan and finishes from criterion evidence", async ({
  launchApp
}) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    sessions: session()
  })
  await expect(appShell(launched.window)).toBeVisible()
  await proposePlan(launched)
  const { window } = launched

  // Approve via the split button's dropdown ("More plan actions").
  await window.getByRole("button", { name: "More plan actions" }).click()
  await window.getByRole("menuitem", { name: "Approve and auto", exact: true }).click()

  await expect(window.getByRole("button", { name: "Plan completed" })).toBeVisible({
    timeout: 30_000
  })
  const persisted = readFileSync(currentPlanPath(launched), "utf8")
  expect(persisted).toContain('"status": "done"')
  expect(persisted).toContain('"status": "passed"')
  await window.getByTestId("active-chat-tab").first().click()
  await expect(window.getByText("Steps 2, 3 and 5 are done.")).toBeVisible()
  await expect(window.getByText(/PLAN_RESULT/)).toHaveCount(0)
})

test("restart resumes the exact canonical revision", async ({ launchApp }) => {
  const first = await launchApp({
    configured: true,
    withRepo: true,
    sessions: session()
  })
  await expect(appShell(first.window)).toBeVisible()
  await proposePlan(first)
  await first.app.close()

  const reopened = await launchApp({
    home: first.home,
    reposDir: first.reposDir,
    userDataDir: first.userDataDir,
    configured: true,
    withRepo: true
  })
  await expect(appShell(reopened.window)).toBeVisible()
  await reopened.window.getByRole("button", { name: "Plan Review" }).first().click()
  // A restored plan re-opens stale, offering a resume of the exact revision.
  await expect(reopened.window.getByText("stale", { exact: true })).toBeVisible()
  await expect(
    reopened.window.getByText("Audit session middleware", { exact: true })
  ).toBeVisible()
  await reopened.window.getByRole("button", { name: "Approve & implement" }).click()
  await reopened.window.getByTestId("active-chat-tab").first().click()
  await reopened.window.getByRole("button", { name: /Allow once/ }).click()
  await reopened.window.getByRole("button", { name: "Plan Review" }).first().click()
  await expect(
    reopened.window.getByText("needs verification", { exact: true })
  ).toBeVisible({ timeout: 30_000 })
})

test("plan file chips render on the step outline with diff evidence", async ({
  launchApp
}) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    seed: seedPlanAsset,
    sessions: session()
  })
  await expect(appShell(launched.window)).toBeVisible()
  await proposePlan(launched)
  const { window } = launched

  // Each step's Changes section renders its declared edits as inline file chips.
  await expect(window.getByText("src/auth/token-store.ts", { exact: true })).toBeVisible()
  await expect(window.getByText("src/auth/refresh.ts").first()).toBeVisible()
  await expect(window.getByText("src/auth/session.test.ts", { exact: true }).first()).toBeVisible()
})

test("an external write to the plan file live-updates the outline (Plan.watch)", async ({
  launchApp
}) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    sessions: session()
  })
  await expect(appShell(launched.window)).toBeVisible()
  await proposePlan(launched)

  const file = currentPlanPath(launched)
  const persisted = readFileSync(file, "utf8")
  const revision = revisionOf(file)
  // No local edits are possible, so a higher-revision external write is adopted
  // and its new content must appear on the read-only outline without a reload.
  const remote = persisted
    .replace(/"revision":\s*\d+/, `"revision": ${revision + 1}`)
    .replace(
      '"title": "Audit session middleware"',
      '"title": "Audit session middleware WATCH_LIVE_UPDATE"'
    )
  writeFileSync(file, remote)

  await expect(launched.window.getByText(/WATCH_LIVE_UPDATE/)).toBeVisible({
    timeout: 10_000
  })
})

test("the Plan Review tab is always present and can seed a draft to author", async ({
  launchApp
}) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    sessions: session()
  })
  await expect(appShell(launched.window)).toBeVisible()

  // Present with NO plan proposed yet (previously gated on a plan existing).
  const tab = launched.window.getByRole("button", { name: "Plan Review" }).first()
  await expect(tab).toBeVisible()
  await tab.click()

  // Empty state offers a way to start authoring a plan for the agent.
  await launched.window.getByRole("button", { name: "Start a plan" }).click()

  // A blank draft (from the template) renders as the read-only plan surface.
  await expect(launched.window.getByTestId("plan-review-container")).toBeVisible({
    timeout: 20_000
  })
  await expect
    .poll(() => readFileSync(currentPlanPath(launched), "utf8"))
    .toContain('"status": "draft"')
  // A local draft can move directly into the one approval gate.
  await expect(
    launched.window.getByRole("button", { name: "Approve & implement" })
  ).toBeVisible()
})

test("Claude, Codex, and opencode share native plan mode", async ({ launchApp }) => {
  for (const cli of ["claude", "codex", "opencode"] as const) {
    const launched = await launchApp({
      configured: true,
      withRepo: true,
      sessions: session(cli),
      ...(cli === "opencode" ? { opencode: { providers: [] } } : {})
    })
    await expect(appShell(launched.window)).toBeVisible()
    const composer = launched.window.getByPlaceholder(/Message .+…/)
    await composer.click()
    await launched.window.keyboard.press("Shift+Tab")
    await launched.window.keyboard.press("Shift+Tab")
    await expect(launched.window.locator("[data-mode='plan']")).toBeVisible()
    await composer.fill(`Plan this change with ${cli}.`)
    await composer.press("Enter")
    await expect(
      launched.window.getByRole("button", { name: "Plan Review" }).first()
    ).toBeVisible({ timeout: 20_000 })
    // The Plan Review tab is now always present, so it no longer implies a plan
    // exists — wait for the agent to actually write the canonical file.
    await expect
      .poll(
        () =>
          existsSync(currentPlanPath(launched))
            ? readFileSync(currentPlanPath(launched), "utf8")
            : "",
        { timeout: 20_000 }
      )
      .toContain("\"revision\"")
    await launched.app.close()
  }
})

test("switching to a Codex model keeps the active plan mode", async ({ launchApp }) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    sessions: session()
  })
  await expect(appShell(launched.window)).toBeVisible()

  const composer = launched.window.getByPlaceholder("Message Claude…")
  await composer.click()
  await launched.window.keyboard.press("Shift+Tab")
  await launched.window.keyboard.press("Shift+Tab")
  const surface = launched.window.locator("[data-mode]").first()
  await expect(surface).toHaveAttribute("data-mode", "plan")

  await launched.window
    .getByRole("button", { name: DEFAULT_CLAUDE_MODEL, exact: true })
    .click()
  await expect(launched.window.getByText("Codex CLI", { exact: true })).toBeVisible()
  await launched.window
    .getByRole("menuitem")
    .filter({ hasText: /^GPT-5\./ })
    .first()
    .click()

  const codexComposer = launched.window.getByPlaceholder("Message Codex…")
  await expect(codexComposer).toBeVisible()
  await expect(surface).toHaveAttribute("data-mode", "plan")

  await codexComposer.fill("Plan this change after switching to Codex.")
  await codexComposer.press("Enter")
  await expect
    .poll(
      () =>
        existsSync(currentPlanPath(launched))
          ? readFileSync(currentPlanPath(launched), "utf8")
          : "",
      { timeout: 20_000 }
    )
    .toContain("\"revision\"")
})
