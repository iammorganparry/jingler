import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { appShell, expect, test } from "./fixtures.js"

test("imports sessions from all four sources", async ({ launchApp }) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    seed: ({ home, repoPath }) => {
      // Claude Code: ~/.claude/projects/<slug>/session_*.jsonl
      const claudeDir = join(home, ".claude", "projects", "widget-main")
      mkdirSync(claudeDir, { recursive: true })
      writeFileSync(
        join(claudeDir, "session_claude123.jsonl"),
        [
          JSON.stringify({
            type: "user",
            sessionId: "claude123",
            cwd: repoPath,
            gitBranch: "main",
            timestamp: "2026-10-01T12:00:00.000Z",
            message: { content: "Fix login from Claude Code" }
          }),
          JSON.stringify({
            type: "assistant",
            timestamp: "2026-10-01T12:01:00.000Z"
          })
        ].join("\n")
      )

      // Codex: ~/.codex/sessions/YYYY/MM/DD/*.jsonl
      const codexDir = join(home, ".codex", "sessions", "2026", "10", "01")
      mkdirSync(codexDir, { recursive: true })
      writeFileSync(
        join(codexDir, "session_codex456.jsonl"),
        [
          JSON.stringify({
            type: "session_meta",
            timestamp: "2026-10-01T14:00:00.000Z",
            payload: {
              id: "codex456",
              cwd: repoPath,
              git: { branch: "main" }
            }
          }),
          JSON.stringify({
            type: "response_item",
            timestamp: "2026-10-01T14:01:00.000Z",
            payload: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "Add tests from Codex" }]
            }
          })
        ].join("\n")
      )

      // Conductor: ~/Library/Application Support/com.conductor.app/conductor.db
      const conductorDbDir = join(home, "Library", "Application Support", "com.conductor.app")
      mkdirSync(conductorDbDir, { recursive: true })
      const conductorDb = new DatabaseSync(join(conductorDbDir, "conductor.db"))
      conductorDb.exec(`
        CREATE TABLE workspaces (
          id TEXT PRIMARY KEY,
          workspace_path TEXT,
          branch TEXT
        )
      `)
      conductorDb.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          claude_session_id TEXT,
          agent_type TEXT,
          title TEXT,
          updated_at TEXT,
          workspace_id TEXT,
          is_hidden INTEGER DEFAULT 0
        )
      `)
      conductorDb.prepare("INSERT INTO workspaces (id, workspace_path, branch) VALUES (?, ?, ?)").run("w1", repoPath, "main")
      conductorDb.prepare("INSERT INTO sessions (id, claude_session_id, agent_type, title, updated_at, workspace_id, is_hidden) VALUES (?, ?, ?, ?, ?, ?, ?)").run("s1", "conductor789", "claude", "Refactor from Conductor", "2026-10-02T10:00:00Z", "w1", 0)
      conductorDb.close()

      // T3 Code: ~/.t3/userdata/state.sqlite
      const t3DbDir = join(home, ".t3", "userdata")
      mkdirSync(t3DbDir, { recursive: true })
      const t3Db = new DatabaseSync(join(t3DbDir, "state.sqlite"))
      t3Db.exec(`
        CREATE TABLE projection_projects (
          project_id TEXT PRIMARY KEY,
          workspace_root TEXT NOT NULL
        )
      `)
      t3Db.exec(`
        CREATE TABLE projection_threads (
          thread_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          title TEXT NOT NULL,
          branch TEXT,
          worktree_path TEXT,
          updated_at TEXT NOT NULL,
          deleted_at TEXT
        )
      `)
      t3Db.exec(`
        CREATE TABLE projection_thread_sessions (
          thread_id TEXT PRIMARY KEY,
          provider_name TEXT,
          provider_session_id TEXT
        )
      `)
      t3Db.prepare("INSERT INTO projection_projects (project_id, workspace_root) VALUES (?, ?)").run("p1", repoPath)
      t3Db.prepare("INSERT INTO projection_threads (thread_id, project_id, title, branch, worktree_path, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run("t1", "p1", "Deploy from T3 Code", "main", null, "2026-10-03T08:00:00Z", null)
      t3Db.prepare("INSERT INTO projection_thread_sessions (thread_id, provider_name, provider_session_id) VALUES (?, ?, ?)").run("t1", "anthropic", "t3abc")
      t3Db.close()
    }
  })

  await expect(appShell(launched.window)).toBeVisible()

  const importButton = launched.window.getByRole("button", { name: "Import sessions…" })
  await importButton.click()

  const dialog = launched.window.getByRole("dialog")
  await expect(dialog).toBeVisible()

  // All four sources should be listed
  await expect(dialog.getByText("Fix login from Claude Code")).toBeVisible({ timeout: 10_000 })
  await expect(dialog.getByText("Add tests from Codex")).toBeVisible()
  await expect(dialog.getByText("Refactor from Conductor")).toBeVisible()
  await expect(dialog.getByText("Deploy from T3 Code")).toBeVisible()

  // Import the Claude Code session
  const checkbox = dialog.getByRole("checkbox", { name: /Select Fix login from Claude Code/ })
  await checkbox.check()

  const importActionButton = dialog.getByRole("button", { name: /Import 1 session/ })
  await importActionButton.click()

  await expect(dialog).toHaveCount(0, { timeout: 15_000 })

  // Verify the session was imported with the correct metadata
  const sessionsPath = join(launched.home, "jingler", "sessions.json")
  await expect.poll(() => existsSync(sessionsPath)).toBe(true)

  const persisted = JSON.parse(readFileSync(sessionsPath, "utf8"))
  const imported = persisted.find((s: any) => s.title === "Fix login from Claude Code")
  expect(imported).toBeDefined()
  expect(imported.repo).toBe("widget")
  expect(imported.importedFrom).toMatchObject({
    source: "claude-code",
    nativeSessionId: "claude123"
  })

  // Opening the imported workspace shows the native transcript.
  await launched.window.getByTestId(`session-row-${imported.id}`).click()
  await expect(launched.window.getByText("Fix login from Claude Code").first()).toBeVisible()
})
