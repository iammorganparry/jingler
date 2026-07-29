import { existsSync, readFileSync } from "node:fs"
import { basename, join } from "node:path"
import { appShell, expect, sessionRow, test } from "./fixtures.js"

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
  await expect(window.getByText("claude · sonnet").first()).toBeVisible()
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
  await composer.fill(
    "[[amendment]] add the requested audit coverage without stopping the workers"
  )
  await composer.press("Enter")
  await expect
    .poll(() => readFileSync(planFile, "utf8"), { timeout: 20_000 })
    .toContain("requested audit amendment")

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
