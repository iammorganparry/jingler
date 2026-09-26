import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { appShell, expect, test, type SeedSession } from "./fixtures.js"

const CONNECTION_ID = "jingler-e2e-connection"
const MODEL_ID = "jingler-e2e/eval-model"
const SESSION_ID = "s_managed_resources"
const CHAT_ID = "c_managed_resources_1"

const seededSession = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [{
  id: SESSION_ID,
  repo: "widget",
  branch: "main",
  title: "Managed resources",
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
    id: CHAT_ID,
    title: null,
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
    mode: "ask",
    connectionId: CONNECTION_ID,
    providerId: "jingler-e2e",
    modelId: MODEL_ID
  }],
  activeChatId: CHAT_ID
}]

test("Jingler-owned Ponytail commands survive an app restart", async ({ launchApp }) => {
  const first = await launchApp({
    configured: true,
    withRepo: true,
    piFixture: { scenarioId: "portable-commands", authRoute: "api-key" },
    sessions: seededSession
  })
  await expect(appShell(first.window)).toBeVisible()
  const composer = first.window.getByPlaceholder("Message the agent…")
  await composer.fill("/ponytail ultra")
  await composer.press("Enter")
  await expect(first.window.getByText("Ponytail: ultra.", { exact: true })).toBeVisible()
  await first.app.close()

  const resumed = await launchApp({
    home: first.home, reposDir: first.reposDir, userDataDir: first.userDataDir,
    configured: true, withRepo: true,
    piFixture: { scenarioId: "portable-commands", authRoute: "api-key" }
  })
  await expect(appShell(resumed.window)).toBeVisible()
  const resumedComposer = resumed.window.getByPlaceholder("Message the agent…")
  await resumedComposer.fill("/ponytail status")
  await resumedComposer.press("Enter")
  await expect(resumed.window.getByText("Ponytail: ultra.", { exact: true })).toHaveCount(2)
})

test("invokes an imported skill through the real pi runtime", async ({ launchApp }) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    piFixture: { scenarioId: "managed-resources", authRoute: "api-key" },
    sessions: seededSession,
    seed: ({ home }) => {
      const root = join(home, "jingler", "agent-resources")
      const skill = join(root, "skills", "managed-skill", "SKILL.md")
      mkdirSync(join(root, "skills", "managed-skill"), { recursive: true })
      writeFileSync(skill, "Use the imported managed skill.\n")
      writeFileSync(join(root, "catalog.json"), JSON.stringify([{
        id: "managed-skill",
        kind: "skill",
        name: "Managed skill",
        description: "Loads an operator-approved managed skill.",
        enabled: true,
        trust: "operator-approved",
        scope: { kind: "portable", allowedTargets: [] },
        managedPath: skill,
        byteLength: 32,
        provenance: {
          origin: "jingler",
          sourceRoot: root,
          sourcePath: skill,
          importedAt: "2026-08-10T00:00:00.000Z"
        }
      }], null, 2))
    }
  })

  await expect(appShell(launched.window)).toBeVisible()
  const composer = launched.window.getByPlaceholder("Message the agent…")
  await composer.fill("Use the managed skill.")
  await composer.press("Enter")

  await expect(
    launched.window.getByText("Managed skill loaded through pi.")
  ).toBeVisible({ timeout: 20_000 })
})
