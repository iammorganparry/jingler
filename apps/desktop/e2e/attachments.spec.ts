import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appShell, expect, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

/**
 * End-to-end coverage for this pass's UI additions, against the built app and the
 * deterministic scripted adapter: attaching an image as context (thumbnail in the
 * composer, then persisted on the sent user turn) and queueing a message while the
 * agent is busy. We assert on what the operator sees, never on internals.
 *
 * NOTE: the "Changes" rail + header toggle this file used to cover was replaced by
 * a top-level Changes tab (see `rail→tab` in #21); that tab is covered by
 * chat.spec.ts — "a worktree session without a PR shows a Changes tab".
 */

const seededSessions = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [
  {
    id: "s_seeded",
    repo: "widget",
    branch: "chore/refactor",
    title: "Refactor auth flow",
    status: "idle",
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-07-11T00:00:00.000Z",
    worktreePath: repoPath,
    mode: "accept-edits"
  }
]

/** A tiny on-disk PNG the file picker can attach. */
const writeTinyPng = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "jingler-e2e-img-"))
  const path = join(dir, "login.png")
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64"
  )
  writeFileSync(path, png)
  return path
}

test("attaching an image shows a thumbnail and persists it on the sent turn", async ({
  launchApp
}) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: seededSessions })
  await expect(appShell(window)).toBeVisible()

  const composer = window.getByPlaceholder("Message the agent…")
  await expect(composer).toBeVisible()

  // Attach an image through the hidden file input (the picker the paperclip opens).
  await window.locator('input[type="file"]').setInputFiles(writeTinyPng())

  // The pending attachment renders as a thumbnail in the composer (by filename).
  await expect(window.getByRole("img", { name: "login.png" })).toBeVisible()

  // Send with a line of text → the user turn carries the image thumbnail + text.
  await composer.click()
  await composer.pressSequentially("Here is the failing screen.")
  await composer.press("Enter")

  // Scoped to the transcript: multi-chat renames an untitled chat after its first
  // prompt, so this string becomes the chat tab's label too — asynchronously, which
  // made the unscoped matcher a RACE rather than a clean failure. It passed while
  // the rename was in flight and tripped strict mode once it landed.
  await expect(
    window.getByTestId("conversation-scroll").getByText("Here is the failing screen.")
  ).toBeVisible()
  // The image persists on the sent turn (still visible after the composer clears).
  await expect(window.getByRole("img", { name: "login.png" })).toBeVisible()
})
