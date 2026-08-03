import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "./fixtures.js"
import { startFakeAuthServer } from "./fake-auth.js"

// The Export button is a user-facing feature, so it ships an `_electron` e2e.
// The native save picker is Electron-only; we override `dialog.showSaveDialog`
// in the main process to a deterministic temp path, click Export, then read the
// written archive back off disk and verify representative vault entries.
test("Memory export writes the accepted vault to the chosen ZIP path", async ({ launchApp }) => {
  const fake = await startFakeAuthServer()
  const outDir = mkdtempSync(join(tmpdir(), "jingler-e2e-export-"))
  const destination = join(outDir, "team-memory.zip")
  try {
    const app = await launchApp({
      authServer: fake,
      configured: true,
      config: { memory: { enabled: true, organizationId: "org-e2e" } }
    })

    // Stub the native save dialog to accept our deterministic destination.
    await app.app.evaluate(async ({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath })
    }, destination)

    await app.window.getByTestId("memory-sidebar-item").click()
    await expect(app.window.getByRole("heading", { name: "Memory overview" })).toBeVisible()

    const exportButton = app.window.getByRole("button", { name: "Export" })
    await expect(exportButton).toBeEnabled()
    await exportButton.click()

    // The button flips to "Exported" once main has written the archive.
    await expect(app.window.getByRole("button", { name: "Exported" })).toBeVisible()

    const archive = readFileSync(destination)
    // Local-file-header signature: an actual ZIP envelope, not an error payload.
    expect(archive.readUInt32LE(0)).toBe(0x04034b50)
    // End-of-central-directory signature closes the archive.
    expect(archive.readUInt32LE(archive.length - 22)).toBe(0x06054b50)
    const text = archive.toString("utf8")
    expect(text).toContain(".obsidian/app.json")
    expect(text).toContain("alpha.md")
    expect(text).toContain("Alpha memory")
    expect(text).toContain("[[beta]]")
  } finally {
    rmSync(outDir, { recursive: true, force: true })
    await fake.close()
  }
})
