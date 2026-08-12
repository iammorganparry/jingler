import { execFileSync } from "node:child_process"
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { expect, test } from "@playwright/test"
import type { Page } from "@playwright/test"
import { _electron as electron } from "playwright"
import { appShell, sessionRow } from "./fixtures.js"
import { MAIN_ENTRY } from "./global-setup.js"

const runRealManagedQa = process.env.JINGLER_REAL_MANAGED_QA === "1"
const realAuthToken = process.env.JINGLER_REAL_AUTH_TOKEN
const realAuthUrl = process.env.JINGLER_REAL_AUTH_URL ?? "https://api.jingler.dev"
const repositoryUrl =
  process.env.JINGLER_REAL_MANAGED_REPOSITORY ??
  "https://github.com/iammorganparry/jingler.git"
const DEVICES_SECTION = /^Devices/
const CONTINUATION_ROW = /continuation/i
const MESSAGE_BOX = /Message/

test.describe("real managed environment canary", () => {
  test.skip(
    !(runRealManagedQa && realAuthToken),
    "Set JINGLER_REAL_MANAGED_QA=1 and JINGLER_REAL_AUTH_TOKEN to run the production-backed canary."
  )

  test("runs directly in Cloud, then stops local work and continues it there", async () => {
    test.setTimeout(12 * 60_000)
    const root = mkdtempSync(join(tmpdir(), "jingler-real-managed-"))
    const home = join(root, "home")
    const jinglerHome = join(home, "jingler")
    const reposDir = join(root, "repos")
    const repoPath = join(reposDir, "jingler")
    const userDataDir = join(root, "chromium")
    let app: Awaited<ReturnType<typeof electron.launch>> | undefined
    let window: Page | undefined

    try {
      mkdirSync(jinglerHome, { recursive: true })
      mkdirSync(reposDir, { recursive: true })
      execFileSync("git", ["clone", "--depth=1", repositoryUrl, repoPath], {
        stdio: "inherit"
      })
      writeFileSync(join(jinglerHome, "auth.enc"), realAuthToken!, {
        mode: 0o600
      })
      writeFileSync(
        join(jinglerHome, "config.json"),
        JSON.stringify(
          {
            reposDir,
            createdAt: new Date().toISOString(),
            lastRepoPath: repoPath,
            defaultCli: "codex",
            providers: {
              codex: {
                enabled: true,
                defaultMode: "auto",
                defaultModel: "gpt-5.6-sol",
                thinkingEnabled: true,
                reasoningEffort: "low",
                outputStyle: "concise"
              }
            }
          },
          null,
          2
        )
      )
      writeFileSync(
        join(jinglerHome, "projects.json"),
        JSON.stringify(
          [
            {
              id: "p_real_managed_qa",
              name: basename(repoPath),
              path: repoPath,
              availability: "available",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            }
          ],
          null,
          2
        )
      )
      writeFileSync(join(jinglerHome, "sessions.json"), "[]\n")

      app = await electron.launch({
        args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
        env: {
          ...process.env,
          ELECTRON_RENDERER_URL: "",
          JINGLER_AUTH_URL: realAuthUrl,
          JINGLER_E2E: "0",
          JINGLER_E2E_HEADLESS: process.env.JINGLER_E2E_HEADED === "1" ? "0" : "1",
          JINGLER_HOME: home,
          JINGLER_SECRET_STORE: "memory",
          JINGLER_SCRIPTED_AGENT: "0"
        }
      })
      window = await app.firstWindow()
      await window.waitForLoadState("domcontentloaded")
      await expect(appShell(window)).toBeVisible({ timeout: 30_000 })

      await window.getByRole("button", { name: "Account menu" }).click()
      await window.getByRole("menuitem", { name: "Settings" }).click()
      await window.getByRole("button", { name: DEVICES_SECTION }).click()
      await expect(window.getByText("Cloud", { exact: true })).toBeVisible({
        timeout: 30_000
      })
      await expect(
        window.getByRole("button", { name: "Add cloud environment" })
      ).toHaveCount(0)
      await window.getByRole("button", { name: "Close settings" }).click()

      await window.getByTestId("new-session").click()
      await expect(window.getByRole("heading", { name: "New session" })).toBeVisible()
      await window.getByRole("button", { name: "Execution environment" }).click()
      await window.getByRole("option", { name: "Cloud" }).click()
      await window.getByRole("button", { name: "Create workspace" }).click()
      await expect(window.getByTestId("environment-startup-progress")).toBeVisible()
      const pendingCloud = window.getByTestId("pending-environment-session")
      await expect(pendingCloud).toBeVisible()
      const startupAlert = window.getByRole("alert")
      await Promise.race([
        expect(window.getByTestId("environment-startup-progress")).toHaveCount(0, {
          timeout: 5 * 60_000
        }),
        startupAlert.waitFor({ state: "visible", timeout: 5 * 60_000 }).then(async () => {
          throw new Error(`Cloud startup failed: ${await startupAlert.textContent()}`)
        })
      ])
      const directCloudRow = sessionRow(window, "Untitled session")
      await expect(directCloudRow).toBeVisible({ timeout: 30_000 })
      await expect(window.getByRole("button", { name: "Execution environment" })).toContainText(
        "Cloud"
      )
      const directCloudPrompt = window.getByRole("textbox", { name: MESSAGE_BOX })
      await expect(directCloudPrompt).toBeVisible()
      await directCloudPrompt.fill(
        "Create docs/direct-cloud-qa-marker.md containing exactly `direct cloud QA passed`. Do not commit or push."
      )
      await directCloudPrompt.press("Enter")
      await expect(window.getByRole("button", { name: "Stop", exact: true })).toBeVisible({
        timeout: 90_000
      })
      await expect(window.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0, {
        timeout: 5 * 60_000
      })
      await window.getByRole("button", { name: "Changes" }).first().click()
      const directCloudChanges = window.getByRole("region", { name: "Code review changes" })
      await expect(directCloudChanges).toContainText("docs/direct-cloud-qa-marker.md", {
        timeout: 60_000
      })
      await expect(directCloudChanges).toContainText("direct cloud QA passed")
      await window.getByTestId("active-chat-tab").click()

      await window.getByTestId("new-session").click()
      await expect(window.getByRole("heading", { name: "New session" })).toBeVisible()
      await window.getByRole("button", { name: "Execution environment" }).click()
      await window.getByRole("option", { name: "Local" }).click()
      const prompt = window.getByRole("textbox", { name: MESSAGE_BOX })
      await prompt.fill(
        "Create docs/managed-cloud-qa-marker.md containing exactly `managed cloud QA passed`. Do not commit or push."
      )
      await prompt.press("Enter")

      const localRow = sessionRow(window, "Untitled session")
      await expect(localRow).toBeVisible({ timeout: 90_000 })
      await expect(window.getByRole("button", { name: "Stop", exact: true })).toBeVisible({
        timeout: 90_000
      })
      await expect(window.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0, {
        timeout: 5 * 60_000
      })

      // Prove the source workspace is dirty before exercising handoff. Without
      // this boundary assertion a later "missing in Cloud" failure cannot
      // distinguish a transfer bug from work that never existed on the source.
      await window.getByRole("button", { name: "Changes" }).first().click()
      const localChanges = window.getByRole("region", { name: "Code review changes" })
      await expect(localChanges).toContainText("docs/managed-cloud-qa-marker.md", {
        timeout: 90_000
      })
      await expect(localChanges).toContainText("managed cloud QA passed")
      await window.getByTestId("active-chat-tab").click()

      // Keep a second turn live so the selector exercises stop → checkpoint →
      // continuation, without relying on the model to order a write before a
      // long-running shell command inside one turn.
      await prompt.fill("Run `sleep 45` now so I can test a live handoff.")
      await prompt.press("Enter")
      await expect(window.getByRole("button", { name: "Stop", exact: true })).toBeVisible({
        timeout: 90_000
      })

      await window.getByRole("button", { name: "Execution environment" }).click()
      await window.getByRole("option", { name: "Cloud" }).click()
      await expect(window.getByRole("alert")).toContainText("Stop the active turn")
      await window.getByRole("button", { name: "Stop and continue there" }).click()
      const cloudRow = window
        .locator("[data-testid^='session-row-']")
        .filter({ hasText: CONTINUATION_ROW })
      await expect(cloudRow).toBeVisible({ timeout: 3 * 60_000 })
      await cloudRow.click()
      await expect(window.getByRole("button", { name: "Execution environment" })).toContainText(
        "Cloud"
      )
      await window.getByRole("button", { name: "Changes" }).first().click()
      const handedOffChanges = window.getByRole("region", { name: "Code review changes" })
      await expect(handedOffChanges).toContainText("docs/managed-cloud-qa-marker.md", {
        timeout: 60_000
      })
      await expect(handedOffChanges).toContainText("managed cloud QA passed")
      await window.getByTestId("active-chat-tab").click()

      await prompt.fill(
        "Append a second line containing exactly `cloud continuation passed` to docs/managed-cloud-qa-marker.md. Do not commit or push."
      )
      await prompt.press("Enter")
      await expect(window.getByRole("button", { name: "Stop", exact: true })).toBeVisible({
        timeout: 90_000
      })
      await expect(window.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0, {
        timeout: 5 * 60_000
      })

      await window.screenshot({ path: resolve(root, "managed-cloud-handoff.png") })
    } finally {
      await app?.close().catch(() => undefined)
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })
})
