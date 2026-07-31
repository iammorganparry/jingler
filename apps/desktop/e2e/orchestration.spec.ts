import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  appShell,
  DEFAULT_CLAUDE_MODEL,
  expect,
  planDirectory,
  sessionRow,
  test
} from "./fixtures.js"

test("Jingler mode keeps the composer neutral and animates the Jingler mark", async ({
  launchApp
}) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    config: {
      orchestrator: { cli: "codex", model: "gpt-5.6-sol" }
    }
  })
  await window.emulateMedia({ reducedMotion: "no-preference" })
  await expect(appShell(window)).toBeVisible()

  await window.getByTestId("new-session").click()
  await window
    .getByPlaceholder("Leave blank for agent naming")
    .fill("Branded Jingler mode")
  await window.getByRole("button", { name: "Create" }).click()
  await expect(sessionRow(window, "Branded Jingler mode")).toBeVisible()

  const toggle = window.getByRole("button", { name: "Jingler", exact: true })
  const surface = window.getByTestId("composer").locator("[data-jingler-mode]")

  await expect(toggle).toHaveAttribute("aria-pressed", "true")
  await expect(toggle.locator('svg[aria-label="Jingler"]')).toBeVisible()
  await expect(toggle.locator(".lucide-sparkles")).toHaveCount(0)
  await expect(surface).toHaveAttribute("data-jingler-mode", "true")

  const activeTreatment = await surface.evaluate((element) => {
    const surfaceStyle = getComputedStyle(element)
    return surfaceStyle.backgroundImage
  })
  expect(activeTreatment).toBe("none")

  const toggleTreatment = await toggle.evaluate((element) => {
    const buttonStyle = getComputedStyle(element)
    const labelStyle = getComputedStyle(element.querySelector("span")!)
    const markStyle = getComputedStyle(element.querySelector("svg")!)
    return {
      border: buttonStyle.borderStyle,
      background: buttonStyle.backgroundColor,
      labelAnimation: labelStyle.animationName,
      markAnimation: markStyle.animationName
    }
  })
  expect(toggleTreatment).toMatchObject({
    border: "none",
    background: "rgba(0, 0, 0, 0)",
    labelAnimation: "sb-jingler-text-shine",
    markAnimation: "sb-jingler-mark-shine"
  })

  await window.getByRole("button", { name: "New chat" }).click()
  await expect(window.getByTitle("2. Chat 2")).toHaveAttribute(
    "aria-current",
    "page"
  )

  await toggle.click()
  await expect(toggle).toHaveAttribute("aria-pressed", "false")
  await expect(surface).toHaveAttribute("data-jingler-mode", "false")
  await expect(window.getByRole("button", { name: "GPT-5.6 Sol" })).toBeVisible()

  await window.getByTitle("1. Chat 1").click()
  await expect(toggle).toHaveAttribute("aria-pressed", "true")
  await expect(surface).toHaveAttribute("data-jingler-mode", "true")

  await window.getByTitle("2. Chat 2").click()
  await expect(toggle).toHaveAttribute("aria-pressed", "false")
  await expect(surface).toHaveAttribute("data-jingler-mode", "false")
})

test("an existing Jingler plan can change its orchestrator model across restart", async ({
  launchApp
}) => {
  const first = await launchApp({
    configured: true,
    withRepo: true
  })
  await expect(appShell(first.window)).toBeVisible()

  await first.window.getByTestId("new-session").click()
  await first.window
    .getByPlaceholder("Leave blank for agent naming")
    .fill("Switchable orchestrator")
  await first.window.getByRole("button", { name: "Create" }).click()
  await expect(sessionRow(first.window, "Switchable orchestrator")).toBeVisible()

  const sessionsFile = join(first.home, "jingler", "sessions.json")
  const session = JSON.parse(readFileSync(sessionsFile, "utf8"))[0] as {
    id: string
    activeChatId: string
    worktreePath: string
  }
  const originalChatId = session.activeChatId
  const planFile = join(
    planDirectory(first.home, session.worktreePath),
    "current-plan.html"
  )
  const composer = first.window.getByPlaceholder("Message Claude…")
  await composer.fill("[[plan]] refactor auth to a TokenStore")
  await composer.press("Enter")
  await expect
    .poll(
      () => (existsSync(planFile) ? readFileSync(planFile, "utf8") : ""),
      { timeout: 20_000 }
    )
    .toContain("jinglerPlan: 1")

  const currentModel = first.window.getByRole("button", {
    name: DEFAULT_CLAUDE_MODEL,
    exact: true
  })
  await expect(currentModel).toBeVisible()
  await currentModel.click()
  await first.window
    .getByRole("menuitem", { name: "GPT-5.6 Sol", exact: true })
    .click()
  await expect(
    first.window.getByRole("button", {
      name: "GPT-5.6 Sol",
      exact: true
    })
  ).toBeVisible()
  await expect
    .poll(() => {
      const stored = JSON.parse(readFileSync(sessionsFile, "utf8")) as ReadonlyArray<{
        id: string
        cli: string
        activeChatId: string
        chats: ReadonlyArray<{ id: string; model?: string }>
      }>
      const target = stored.find((candidate) => candidate.id === session.id)
      const original = target?.chats.find((chat) => chat.id === originalChatId)
      return `${target?.cli}:${original?.model}`
    })
    .toBe("codex:gpt-5.6-sol")

  // Regression: switching tabs used to re-send App's stale Claude session into
  // the resident conversation actor, overwriting its freshly selected Codex
  // model even though sessions.json already contained Sol.
  await first.window.getByRole("button", { name: "New chat" }).click()
  await first.window
    .getByTestId(`chat-tab-${originalChatId}`)
    .locator("button")
    .first()
    .click()
  await expect(
    first.window.getByRole("button", {
      name: "GPT-5.6 Sol",
      exact: true
    })
  ).toBeVisible()
  await first.app.close()

  const second = await launchApp({
    home: first.home,
    reposDir: first.reposDir,
    configured: true,
    withRepo: true
  })
  await sessionRow(second.window, "Switchable orchestrator").click()
  await expect(
    second.window.getByRole("button", {
      name: "GPT-5.6 Sol",
      exact: true
    })
  ).toBeVisible()
  await expect(
    second.window.getByRole("button", { name: "Jingler", exact: true })
  ).toHaveAttribute("aria-pressed", "true")
})

const WORKER_AUTH_TAB = /^agent-01 /
const WORKER_RELEASE_TAB = /^agent-02 /
const AUDIT_WORKER_TAB = /^agent-03 /
const AUDIT_WORKER_ROUTE = /codex · gpt-5\.6-terra · xhigh reasoning/
const REQUESTED_AUDIT_TEXT = /requested audit amendment/
const AUDIT_EVIDENCE =
  /data-acceptance="s_07\.1"[^>]*data-status="passed"[^>]*data-evidence="Scripted worker completed/
const WORKER_STAGE_THOUGHT = "Executing the assigned stage and its verification."

test("an orchestrator completes bounded work directly with its auto tools", async ({
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
  await window
    .getByPlaceholder("Leave blank for agent naming")
    .fill("Bounded direct orchestration")
  await window.getByRole("button", { name: "Create" }).click()
  await expect(sessionRow(window, "Bounded direct orchestration")).toBeVisible()

  const sessions = JSON.parse(
    readFileSync(join(home, "jingler", "sessions.json"), "utf8")
  )
  const worktreePath = sessions[0].worktreePath as string
  const planFile = join(
    planDirectory(home, worktreePath),
    "current-plan.html"
  )

  const composer = window.getByPlaceholder("Message Codex…")
  await composer.fill("Add and verify the one bounded rate-limit change.")
  await composer.press("Enter")

  await expect(window.getByText("1 passed")).toBeVisible({ timeout: 25_000 })
  await expect(window.getByText("Approval needed · run a command")).toHaveCount(0)
  await expect(window.getByRole("button", { name: "Plan Review" })).toHaveCount(0)
  expect(existsSync(planFile)).toBe(false)
})

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
  const lowWorkerModel = window.getByRole("combobox", {
    name: "Low complexity worker model"
  })
  await expect(lowWorkerModel).toHaveText("GPT-5.6 Sol")
  await lowWorkerModel.click()
  await window.getByRole("option", { name: "GPT-5.6 Terra" }).click()
  const lowWorkerReasoning = window.getByRole("combobox", {
    name: "Low complexity worker reasoning"
  })
  await lowWorkerReasoning.click()
  await window.getByRole("option", { name: "xhigh" }).click()
  await expect
    .poll(
      () =>
        JSON.parse(
          readFileSync(join(home, "jingler", "config.json"), "utf8")
        ).workerRouting
    )
    .toMatchObject({
      default: { cli: "claude", model: "opus" },
      low: {
        cli: "codex",
        model: "gpt-5.6-terra",
        reasoning: { enabled: true, effort: "xhigh" }
      },
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
    planDirectory(home, worktreePath),
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
    .toContain('data-agent-id="agent-01"')

  await window.getByRole("button", { name: "Plan Review" }).first().click()
  await expect(window.locator('[data-plan-assignment-card="true"]')).toHaveCount(8)
  await expect(window.getByText("agent-01").first()).toBeVisible()
  await expect(window.getByText("claude · opus").first()).toBeVisible()
  await expect(window.getByText("agent-02").first()).toBeVisible()
  await expect(window.getByText("codex · gpt-5.6-terra").first()).toBeVisible()
  const releaseAssignment = window
    .locator('[data-plan-assignment-card="true"]')
    .filter({ hasText: "agent-02" })
    .first()
  await expect(releaseAssignment).toContainText("Reasoning: xhigh")
  await expect(releaseAssignment).toContainText("queued")
  await expect
    .poll(() => readFileSync(planFile, "utf8"))
    .toContain(
      'data-agent-id="agent-02" data-cli="codex" data-model="gpt-5.6-terra" data-thinking-enabled="true" data-reasoning-effort="xhigh"'
    )

  await window.getByRole("button", { name: "More plan actions" }).click()
  await window
    .getByRole("menuitem", { name: "Approve and auto", exact: true })
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

  await window.getByTestId("active-chat-tab").first().click()
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
  await expect
    .poll(() => readFileSync(planFile, "utf8"), { timeout: 20_000 })
    .toContain(
      'data-agent-id="agent-03" data-cli="codex" data-model="gpt-5.6-terra" data-thinking-enabled="true" data-reasoning-effort="xhigh"'
    )
  // Worker tabs belong to the canonical plan, not to the orchestrator's latest
  // turn. Amending that same plan must not sweep either transcript away.
  await expect(workerAuthTab).toBeVisible()
  await expect(workerReleaseTab).toBeVisible()
  const auditWorkerTab = window
    .locator("[data-agent-status]")
    .getByRole("button", { name: AUDIT_WORKER_TAB })
  await expect(auditWorkerTab).toBeVisible()
  await expect(auditWorkerTab).toHaveAttribute(
    "title",
    AUDIT_WORKER_ROUTE
  )

  await window.getByRole("button", { name: "Plan Review" }).first().click()
  const auditAssignment = window
    .locator('[data-plan-assignment-card="true"]')
    .filter({ hasText: "agent-03" })
    .first()
  await expect(auditAssignment).toContainText("codex · gpt-5.6-terra")
  await expect(auditAssignment).toContainText("Reasoning: xhigh")
  await expect(
    window.getByText(REQUESTED_AUDIT_TEXT).first()
  ).toBeVisible()
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
    .toBe(9)

  await expect
    .poll(() => readFileSync(planFile, "utf8"), { timeout: 30_000 })
    .toContain('status: "done"')

  // Plan.watch normally applies the completed canonical revision directly. If
  // an editor save races that revision, the same valid result is presented as
  // a conflict instead; accept the remote canonical revision in that case.
  const completedStatus = window.getByText("done", { exact: true }).first()
  const morePlanActions = window.getByRole("button", {
    name: "More plan actions",
  })
  await expect
    .poll(
      async () =>
        (await completedStatus.isVisible()) ||
        (await morePlanActions.isVisible()),
      { timeout: 30_000 }
    )
    .toBe(true)
  if (await morePlanActions.isVisible()) {
    await morePlanActions.click()
    await window.getByRole("menuitem", { name: "Use remote revision" }).click()
  }
  await expect(completedStatus).toBeVisible()

  const persisted = readFileSync(planFile, "utf8")
  expect(persisted).toContain('status: "done"')
  expect(persisted).toContain(
    'data-agent-id="agent-02" data-cli="codex" data-model="gpt-5.6-terra" data-thinking-enabled="true" data-reasoning-effort="xhigh"'
  )
  expect(persisted).toContain(
    'data-agent-id="agent-03" data-cli="codex" data-model="gpt-5.6-terra" data-thinking-enabled="true" data-reasoning-effort="xhigh"'
  )
  expect(persisted).toContain("requested audit amendment")
  expect(persisted).toContain('data-evidence="Scripted worker completed')
  expect(persisted).toMatch(AUDIT_EVIDENCE)
  const checkpoints = JSON.parse(
    readFileSync(
      join(
        planDirectory(home, worktreePath),
        "orchestration-checkpoints.json"
      ),
      "utf8"
    )
  )
  expect(checkpoints.workers).toHaveLength(3)
  expect(
    checkpoints.workers.every(
      (worker: { state: string }) => worker.state === "completed"
    )
  ).toBe(true)
  expect(checkpoints.workers).toContainEqual(
    expect.objectContaining({ agentId: "agent-03", state: "completed" })
  )
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
  const planDir = planDirectory(first.home, worktreePath)
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
  await first.window.getByRole("button", { name: "More plan actions" }).click()
  await first.window
    .getByRole("menuitem", { name: "Approve and auto", exact: true })
    .click()
  await expect(
    first.window.getByRole("button", {
      name: "Stop worker agent-02"
    })
  ).toBeVisible({ timeout: 20_000 })

  await first.window.getByTestId("active-chat-tab").first().click()
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
  ).toContainText("agent-02 · opus")
  await first.window.getByTestId("plan-progress-stage-s_06").click()
  await expect(first.window.getByLabel("Plan document")).toBeVisible()

  await first.window.getByTestId("active-chat-tab").first().click()
  await first.window
    .getByRole("button", { name: "Stop agent-02", exact: true })
    .click()
  await expect(workerReleaseTab).toBeVisible()
  await expect(workerAuthTab).toBeVisible()
  await expect(
    first.window.getByRole("button", {
      name: "Close agent-02",
      exact: true
    })
  ).toHaveCount(0)
  await expect
    .poll(() => checkpoints().find((worker) => worker.agentId === "agent-02"))
    .toMatchObject({
      state: "interrupted",
      resumeId: expect.any(String)
    })
  await expect
    .poll(() => checkpoints().find((worker) => worker.agentId === "agent-01"))
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
      name: "Retry worker agent-02"
    })
  ).toBeVisible()
  await expect(reopened.window.getByRole("status")).toContainText("Synced")

  await reopened.window
    .getByRole("button", { name: "Retry worker agent-02" })
    .click()
  await expect
    .poll(() => checkpoints().find((worker) => worker.agentId === "agent-02"), {
      timeout: 30_000
    })
    .toMatchObject({
      state: "completed",
      resumeId: expect.any(String)
    })
  await expect(reopened.window.getByRole("button", { name: "Plan completed" })).toBeVisible({
    timeout: 30_000
  })
})
