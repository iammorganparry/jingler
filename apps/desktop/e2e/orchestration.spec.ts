import { existsSync, readFileSync } from "node:fs"
import { basename, join } from "node:path"
import { appShell, expect, sessionRow, test } from "./fixtures.js"

const WORKER_AUTH_TAB = /^worker-auth /
const WORKER_RELEASE_TAB = /^worker-release /
const WORKER_STAGE_THOUGHT = "Executing the assigned stage and its verification."

test("a new orchestrator session runs parallel workers and reconciles a mid-run amendment", async ({
  launchApp
}) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    config: {
      orchestrator: { cli: "codex", model: "gpt-5.6-sol" }
    }
  })
  const { window, home } = launched
  await expect(appShell(window)).toBeVisible()

  await window.getByRole("button", { name: "Account menu" }).click()
  await window.getByRole("menuitem", { name: "Settings" }).click()
  await window.getByRole("button", { name: "Plan", exact: true }).click()
  await window
    .getByRole("combobox", { name: "Low complexity worker harness" })
    .click()
  await window.getByRole("option", { name: "Codex" }).click()
  await expect
    .poll(
      () =>
        JSON.parse(
          readFileSync(join(home, "jingler", "config.json"), "utf8")
        ).workerRouting
    )
    .toMatchObject({
      default: { cli: "claude", model: "opus" },
      low: { cli: "codex", model: "gpt-5.6-sol" },
      medium: { cli: "claude", model: "opus" },
      high: { cli: "claude", model: "opus" }
    })
  await window.getByRole("button", { name: "Close settings" }).click()

  await window.getByTestId("new-session").click()
  await window
    .getByPlaceholder("Leave blank for agent naming")
    .fill("Provider neutral orchestration")
  await window.getByRole("button", { name: "Create" }).click()
  await expect(sessionRow(window, "Provider neutral orchestration")).toBeVisible()

  const sessions = JSON.parse(
    readFileSync(join(home, "jingler", "sessions.json"), "utf8")
  )
  const worktreePath = sessions[0].worktreePath as string
  const planFile = join(
    home,
    "jingler",
    ".jingler",
    basename(worktreePath),
    "current-plan.html"
  )

  const composer = window.getByPlaceholder("Message Codex…")
  await composer.fill("[[plan]] refactor auth to a TokenStore")
  await composer.press("Enter")
  await expect
    .poll(
      () => (existsSync(planFile) ? readFileSync(planFile, "utf8") : ""),
      { timeout: 20_000 }
    )
    .toContain('data-agent-id="worker-auth"')

  await window.getByRole("button", { name: "Plan Review" }).first().click()
  await expect(window.locator('[data-plan-assignment-card="true"]')).toHaveCount(8)
  await expect(window.getByText("worker-auth").first()).toBeVisible()
  await expect(window.getByText("claude · opus").first()).toBeVisible()
  await expect(window.getByText("worker-release").first()).toBeVisible()
  await expect(window.getByText("codex · gpt-5.6-sol").first()).toBeVisible()

  await window
    .getByRole("button", { name: "Approve and auto", exact: true })
    .click()
  await expect
    .poll(
      () =>
        (
          readFileSync(planFile, "utf8").match(
            /data-status="running"/g
          ) ?? []
        ).length,
      { timeout: 20_000 }
    )
    .toBeGreaterThanOrEqual(2)

  await window.getByRole("button", { name: "Conversation" }).first().click()
  const workerAuthTab = window
    .locator("[data-agent-status]")
    .getByRole("button", { name: WORKER_AUTH_TAB })
  const workerReleaseTab = window
    .locator("[data-agent-status]")
    .getByRole("button", { name: WORKER_RELEASE_TAB })
  await expect(workerAuthTab).toBeVisible()
  await expect(workerReleaseTab).toBeVisible()

  await composer.fill(
    "[[amendment]] add the requested audit coverage without stopping the workers"
  )
  await composer.press("Enter")
  await expect
    .poll(() => readFileSync(planFile, "utf8"), { timeout: 20_000 })
    .toContain("requested audit amendment")
  // Worker tabs belong to the canonical plan, not to the orchestrator's latest
  // turn. Amending that same plan must not sweep either transcript away.
  await expect(workerAuthTab).toBeVisible()
  await expect(workerReleaseTab).toBeVisible()

  await window.getByRole("button", { name: "Plan Review" }).first().click()
  await expect(window.getByText(/requested audit amendment/)).toBeVisible()
  await expect
    .poll(
      () =>
        (
          readFileSync(planFile, "utf8").match(
            /data-status="completed"/g
          ) ?? []
        ).length,
      { timeout: 30_000 }
    )
    .toBe(8)

  await expect(window.getByRole("button", { name: "Use remote" })).toBeVisible()
  await window.getByRole("button", { name: "Use remote" }).click()
  await window
    .getByRole("button", { name: "Approve and auto", exact: true })
    .click()
  await expect(window.getByText("All criteria verified")).toBeVisible({
    timeout: 30_000
  })

  const persisted = readFileSync(planFile, "utf8")
  expect(persisted).toContain('status: "done"')
  expect(persisted).toContain("requested audit amendment")
  expect(persisted).toContain('data-evidence="Scripted worker completed')
  const checkpoints = JSON.parse(
    readFileSync(
      join(
        home,
        "jingler",
        ".jingler",
        basename(worktreePath),
        "orchestration-checkpoints.json"
      ),
      "utf8"
    )
  )
  expect(checkpoints.workers).toHaveLength(2)
  expect(
    checkpoints.workers.every(
      (worker: { state: string }) => worker.state === "completed"
    )
  ).toBe(true)
})

test("a stopped worker stays interrupted across restart and retries from its checkpoint", async ({
  launchApp
}) => {
  const first = await launchApp({
    configured: true,
    withRepo: true,
    config: {
      orchestrator: { cli: "codex", model: "gpt-5.6-sol" }
    }
  })
  await expect(appShell(first.window)).toBeVisible()

  await first.window.getByTestId("new-session").click()
  await first.window
    .getByPlaceholder("Leave blank for agent naming")
    .fill("Restartable orchestration")
  await first.window.getByRole("button", { name: "Create" }).click()
  await expect(sessionRow(first.window, "Restartable orchestration")).toBeVisible()

  const sessions = JSON.parse(
    readFileSync(join(first.home, "jingler", "sessions.json"), "utf8")
  )
  const worktreePath = sessions[0].worktreePath as string
  const planDir = join(
    first.home,
    "jingler",
    ".jingler",
    basename(worktreePath)
  )
  const checkpointFile = join(
    planDir,
    "orchestration-checkpoints.json"
  )
  const checkpoints = () =>
    JSON.parse(readFileSync(checkpointFile, "utf8")).workers as ReadonlyArray<{
      agentId: string
      state: string
      resumeId: string | null
    }>

  const composer = first.window.getByPlaceholder("Message Codex…")
  await composer.fill(
    "[[plan]] [[worker-hold]] refactor auth to a TokenStore"
  )
  await composer.press("Enter")
  await first.window.getByRole("button", { name: "Plan Review" }).first().click()
  await first.window
    .getByRole("button", { name: "Approve and auto", exact: true })
    .click()
  await expect(
    first.window.getByRole("button", {
      name: "Stop worker worker-release"
    })
  ).toBeVisible({ timeout: 20_000 })

  await first.window.getByRole("button", { name: "Conversation" }).first().click()
  const workerAuthTab = first.window
    .locator("[data-agent-status]")
    .getByRole("button", { name: WORKER_AUTH_TAB })
  const workerReleaseTab = first.window
    .locator("[data-agent-status]")
    .getByRole("button", { name: WORKER_RELEASE_TAB })
  await expect(workerAuthTab).toBeVisible()
  await expect(workerReleaseTab).toBeVisible()

  // Each tab owns one transcript projection. Auth's evidence must disappear
  // when the held release worker is selected, while release's live tool remains.
  await workerAuthTab.click()
  await expect(
    first.window.getByText(WORKER_STAGE_THOUGHT, { exact: true })
  ).toHaveCount(7, { timeout: 20_000 })
  await workerReleaseTab.click()
  await expect(
    first.window.getByText(WORKER_STAGE_THOUGHT, { exact: true })
  ).toHaveCount(1)
  await expect(first.window.getByText("pnpm test", { exact: true })).toBeVisible()

  await first.window.getByRole("button", { name: "Main", exact: true }).click()
  const progress = first.window.getByRole("button", {
    name: /Plan progress: \d+ of 8 done/
  })
  await expect(progress).toBeVisible()
  await progress.click()
  await expect(
    first.window.getByTestId("plan-progress-stage-s_06")
  ).toContainText("In progress")
  await expect(
    first.window.getByTestId("plan-progress-stage-s_06")
  ).toContainText("worker-release · opus")
  await first.window.getByTestId("plan-progress-stage-s_06").click()
  await expect(
    first.window.locator('[data-plan-stage-id="s_06"] button').first()
  ).toBeFocused()

  await first.window.getByRole("button", { name: "Conversation" }).first().click()
  await first.window
    .getByRole("button", { name: "Stop worker-release", exact: true })
    .click()
  await expect(workerReleaseTab).toBeVisible()
  await expect(workerAuthTab).toBeVisible()
  await expect(
    first.window.getByRole("button", {
      name: "Close worker-release",
      exact: true
    })
  ).toHaveCount(0)
  await expect
    .poll(() => checkpoints().find((worker) => worker.agentId === "worker-release"))
    .toMatchObject({
      state: "interrupted",
      resumeId: expect.any(String)
    })
  await expect
    .poll(() => checkpoints().find((worker) => worker.agentId === "worker-auth"))
    .toMatchObject({ state: "completed" })

  // Stopping release must not retract or disturb its completed sibling. Assert
  // both the authoritative tab state and the replay-backed transcript after the
  // stop, rather than relying only on the checkpoint file.
  await expect(workerAuthTab.locator("..")).toHaveAttribute(
    "data-agent-status",
    "completed"
  )
  await expect(workerReleaseTab.locator("..")).toHaveAttribute(
    "data-agent-status",
    "interrupted"
  )
  await workerAuthTab.click()
  await expect(
    first.window.getByText(WORKER_STAGE_THOUGHT, { exact: true })
  ).toHaveCount(7)

  await first.app.close()
  const reopened = await launchApp({
    home: first.home,
    reposDir: first.reposDir,
    userDataDir: first.userDataDir,
    configured: true,
    withRepo: true
  })
  await expect(appShell(reopened.window)).toBeVisible()
  const reopenedAuthTab = reopened.window
    .locator("[data-agent-status]")
    .getByRole("button", { name: WORKER_AUTH_TAB })
  const reopenedReleaseTab = reopened.window
    .locator("[data-agent-status]")
    .getByRole("button", { name: WORKER_RELEASE_TAB })
  await expect(reopenedAuthTab.locator("..")).toHaveAttribute(
    "data-agent-status",
    "completed"
  )
  await expect(reopenedReleaseTab.locator("..")).toHaveAttribute(
    "data-agent-status",
    "interrupted"
  )
  await reopened.window
    .getByRole("button", { name: "Plan Review" })
    .first()
    .click()
  await expect(
    reopened.window.getByRole("button", {
      name: "Retry worker worker-release"
    })
  ).toBeVisible()

  await reopened.window
    .getByRole("button", { name: "Retry worker worker-release" })
    .click()
  await expect
    .poll(() => checkpoints().find((worker) => worker.agentId === "worker-release"))
    .toMatchObject({
      state: "completed",
      resumeId: expect.any(String)
    })
  await expect(
    reopened.window.getByRole("button", { name: "Use remote" })
  ).toBeVisible()
  await reopened.window.getByRole("button", { name: "Use remote" }).click()
  await expect(reopened.window.getByText("All criteria verified")).toBeVisible({
    timeout: 30_000
  })
})
