import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { appShell, expect, test, type SeedSession } from "./fixtures.js"

const CONNECTION_ID = "jingler-e2e-connection"
const MODEL_ID = "jingler-e2e/eval-model"

const sessions = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [{
  id: "s_runtime_settings",
  repo: "widget",
  branch: "main",
  title: "Runtime settings",
  status: "idle",
  connectionId: CONNECTION_ID,
  providerId: "jingler-e2e",
  modelId: MODEL_ID,
  diff: { added: 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-08-10T00:00:00.000Z",
  worktreePath: repoPath,
  repoPath,
  workspaceMode: "direct",
  chats: [{
    id: "c_runtime_settings_1",
    title: null,
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
    mode: "ask",
    connectionId: CONNECTION_ID,
    providerId: "jingler-e2e",
    modelId: MODEL_ID
  }],
  activeChatId: "c_runtime_settings_1"
}]

const openSettings = async (window: import("@playwright/test").Page): Promise<void> => {
  await expect(appShell(window)).toBeVisible()
  await window.getByRole("button", { name: "Account menu" }).click()
  await window.getByRole("menuitem", { name: "Settings" }).click()
  await expect(window.getByRole("button", { name: "Close settings" })).toBeVisible()
}

test("manages approved resources and inspects a redacted real-pi run", async ({ launchApp }) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    piFixture: { scenarioId: "runtime-diagnostics", authRoute: "api-key" },
    sessions,
    seed: ({ home }) => {
      const root = join(home, "jingler", "agent-resources")
      const prompt = join(root, "prompts", "review.md")
      mkdirSync(join(root, "prompts"), { recursive: true })
      writeFileSync(prompt, "Review the current changes.\n")
      writeFileSync(join(root, "catalog.json"), JSON.stringify([{
        id: "review",
        kind: "prompt",
        name: "Review",
        description: "Review the current changes.",
        enabled: true,
        trust: "operator-approved",
        scope: { kind: "portable", allowedTargets: [] },
        managedPath: prompt,
        byteLength: 28,
        provenance: {
          origin: "jingler",
          sourceRoot: root,
          sourcePath: prompt,
          importedAt: "2026-08-10T00:00:00.000Z"
        }
      }], null, 2))
    }
  })

  const { window } = launched
  const composer = window.getByPlaceholder("Message the agent…")
  await composer.fill("Record a runtime diagnostic.")
  await composer.press("Enter")
  await expect(window.getByText("Completed through deterministic pi.")).toBeVisible({
    timeout: 20_000
  })

  await openSettings(window)
  await window.getByRole("button", { name: "Agents & skills" }).click()
  await expect(window.getByRole("heading", { name: "Agents & skills" })).toBeVisible()
  await expect(window.getByText("Review", { exact: true })).toBeVisible()
  await window.getByRole("switch", { name: "Disable Review" }).click()
  await expect(window.getByRole("switch", { name: "Enable Review" })).toBeVisible()

  await window.getByRole("button", { name: "Runtime" }).click()
  const inspector = window.getByRole("region", { name: "Runtime inspector" })
  await expect(inspector.getByText("api-key")).toBeVisible()
  await expect(inspector.getByText("done", { exact: true })).toBeVisible()
  await expect(inspector.getByText(/prompt 1 · tools 3 · diff 1 · pi 0\.84\.1/)).toBeVisible()
  await inspector.getByRole("button", { name: "Export diagnostics" }).click()
  await expect(inspector.getByRole("status")).toHaveText("Redacted diagnostic bundle prepared.")
  await expect(inspector).not.toContainText("Record a runtime diagnostic")
})
