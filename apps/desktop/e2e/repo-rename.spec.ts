import { basename } from "node:path"
import { expect, sessionRow, showSessions, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

/**
 * Renaming a repo directory used to split one repo across two sidebar groups.
 *
 * `Session.repo` is a denormalised copy of the repo's folder name, captured when
 * the session is created and never revisited, and the sidebar groups on exactly
 * that string. Rename the directory and every session created beforehand keeps
 * grouping under the old name — a heading naming a directory that no longer
 * exists, sitting directly above a second heading for the same repo under its
 * new name.
 *
 * It is worth an e2e rather than only a unit test because the failure is a
 * RENDERING one: `migrateRepoName` can be correct while the sidebar still reads
 * a stale name off some other field, and only driving the real app proves the
 * value reaching the group heading is the derived one.
 */

const seeded = (over: Partial<SeedSession> & { id: string }): SeedSession => ({
  repo: "widget",
  branch: `chore/${over.id}`,
  title: over.id,
  status: "idle",
  cli: "claude",
  diff: { added: 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-07-16T00:00:00.000Z",
  ...over
})

test("groups sessions by the repo's CURRENT directory name, not the one stored at creation", async ({
  launchApp
}) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    // Both sessions live in the SAME repo. They disagree only on the stale
    // display name, which is exactly the state a rename leaves behind: sessions
    // created before it keep the old name, ones created after get the new.
    sessions: ({ repoPath }) => [
      seeded({
        id: "s_before_rename",
        title: "Created before the rename",
        repo: "starbase",
        repoPath
      }),
      seeded({
        id: "s_after_rename",
        title: "Created after the rename",
        repo: basename(repoPath),
        repoPath
      })
    ]
  })

  await showSessions(window, "Active")

  // Both sessions are present …
  await expect(sessionRow(window, "Created before the rename")).toBeVisible()
  await expect(sessionRow(window, "Created after the rename")).toBeVisible()

  const sidebar = window.getByTestId("session-sidebar")

  // … under exactly ONE repo heading, and it is the live directory name.
  const headings = sidebar.getByRole("button", { name: /^(Collapse|Expand) repository$/ })
  await expect(headings).toHaveCount(1)
  await expect(headings.first()).toContainText(basename("widget"))

  // The stale name is gone from the sidebar entirely — not merely deprioritised
  // below the correct one, which is how a half-fix would look.
  await expect(sidebar.getByText("starbase", { exact: true })).toHaveCount(0)
})

test("keeps the stored name for a session that predates repoPath", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    // `repoPath` is optional in the schema: sessions created before it existed
    // have no path to derive a name from. A stale heading beats no heading, so
    // the stored name must survive rather than collapsing to a blank group.
    sessions: [seeded({ id: "s_legacy", title: "Legacy session", repo: "legacy-only" })]
  })

  await showSessions(window, "Active")

  await expect(sessionRow(window, "Legacy session")).toBeVisible()
  await expect(
    window.getByTestId("session-sidebar").getByText("legacy-only", { exact: true })
  ).toBeVisible()
})
