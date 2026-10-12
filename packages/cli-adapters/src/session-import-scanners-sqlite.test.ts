import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { scanConductorSessions, scanT3CodeSessions } from "./session-import-scanners-sqlite.js";

describe("SQLite session scanners", () => {
  let tempHomeDir: string;

  afterEach(async () => {
    if (tempHomeDir) {
      await fs.rm(tempHomeDir, { recursive: true, force: true });
    }
  });

  async function createConductorFixture(sessions: Array<{ id: string; claudeSessionId: string; agentType: string; title: string; updatedAt: string; workspaceId: string }>, workspaces: Array<{ id: string; workspacePath: string; branch: string | null }>) {
    tempHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "jingler-test-"));
    const dbDir = path.join(tempHomeDir, "Library", "Application Support", "com.conductor.app");
    await fs.mkdir(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, "conductor.db");
    
    const db = new DatabaseSync(dbPath);
    
    // Create workspaces table
    db.exec(`
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        workspace_path TEXT,
        branch TEXT
      )
    `);
    
    // Create sessions table
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        claude_session_id TEXT,
        agent_type TEXT,
        title TEXT,
        updated_at TEXT,
        workspace_id TEXT,
        is_hidden INTEGER DEFAULT 0
      )
    `);
    
    // Insert fixtures
    const insertWorkspace = db.prepare("INSERT INTO workspaces (id, workspace_path, branch) VALUES (?, ?, ?)");
    for (const w of workspaces) {
      insertWorkspace.run(w.id, w.workspacePath, w.branch);
    }
    
    const insertSession = db.prepare("INSERT INTO sessions (id, claude_session_id, agent_type, title, updated_at, workspace_id, is_hidden) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const s of sessions) {
      insertSession.run(s.id, s.claudeSessionId, s.agentType, s.title, s.updatedAt, s.workspaceId, 0);
    }
    
    db.close();
    return tempHomeDir;
  }

  async function createT3Fixture(threads: Array<{ threadId: string; projectId: string; title: string; branch: string | null; worktreePath: string | null; updatedAt: string; deletedAt: string | null }>, projects: Array<{ projectId: string; workspaceRoot: string }>, sessions: Array<{ threadId: string; providerName: string; providerSessionId: string }>) {
    tempHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "jingler-test-"));
    const dbDir = path.join(tempHomeDir, ".t3", "userdata");
    await fs.mkdir(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, "state.sqlite");
    
    const db = new DatabaseSync(dbPath);
    
    // Create tables
    db.exec(`
      CREATE TABLE projection_projects (
        project_id TEXT PRIMARY KEY,
        workspace_root TEXT NOT NULL,
        title TEXT NOT NULL,
        scripts_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      )
    `);
    
    db.exec(`
      CREATE TABLE projection_threads (
        thread_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        branch TEXT,
        worktree_path TEXT,
        latest_turn_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        runtime_mode TEXT NOT NULL DEFAULT 'full-access',
        interaction_mode TEXT NOT NULL DEFAULT 'default'
      )
    `);
    
    db.exec(`
      CREATE TABLE projection_thread_sessions (
        thread_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        provider_name TEXT,
        provider_session_id TEXT,
        provider_thread_id TEXT,
        active_turn_id TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL,
        runtime_mode TEXT NOT NULL DEFAULT 'full-access',
        provider_instance_id TEXT
      )
    `);
    
    // Insert fixtures
    const insertProject = db.prepare("INSERT INTO projection_projects (project_id, workspace_root, title, scripts_json, created_at, updated_at) VALUES (?, ?, 'Test', '{}', '2025-01-01', '2025-01-01')");
    for (const p of projects) {
      insertProject.run(p.projectId, p.workspaceRoot);
    }
    
    const insertThread = db.prepare("INSERT INTO projection_threads (thread_id, project_id, title, branch, worktree_path, created_at, updated_at, deleted_at, runtime_mode, interaction_mode) VALUES (?, ?, ?, ?, ?, '2025-01-01', ?, ?, 'full-access', 'default')");
    for (const t of threads) {
      insertThread.run(t.threadId, t.projectId, t.title, t.branch, t.worktreePath, t.updatedAt, t.deletedAt);
    }
    
    const insertSession = db.prepare("INSERT INTO projection_thread_sessions (thread_id, status, provider_name, provider_session_id, updated_at, runtime_mode) VALUES (?, 'idle', ?, ?, '2025-01-01', 'full-access')");
    for (const s of sessions) {
      insertSession.run(s.threadId, s.providerName, s.providerSessionId);
    }
    
    db.close();
    return tempHomeDir;
  }

  it("scanConductorSessions returns empty when DB does not exist", async () => {
    tempHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "jingler-test-"));
    const sessions = await scanConductorSessions({ homeDir: tempHomeDir });
    expect(sessions).toEqual([]);
  });

  it("scanConductorSessions reads claude sessions from conductor.db", async () => {
    const homeDir = await createConductorFixture(
      [
        {
          id: "s1",
          claudeSessionId: "claude-abc123",
          agentType: "claude",
          title: "Test Session",
          updatedAt: "2025-01-15T10:00:00Z",
          workspaceId: "w1"
        }
      ],
      [
        {
          id: "w1",
          workspacePath: "/tmp/test-repo",
          branch: "main"
        }
      ]
    );
    
    const sessions = await scanConductorSessions({ homeDir });
    expect(sessions.length).toBe(1);
    expect(sessions[0]).toMatchObject({
      source: "conductor",
      nativeSessionId: "claude-abc123",
      harness: "claude",
      cwd: "/tmp/test-repo",
      branch: "main",
      title: "Test Session"
    });
  });

  it("scanConductorSessions maps Starbase agent_type to claude harness", async () => {
    const homeDir = await createConductorFixture(
      [
        {
          id: "s1",
          claudeSessionId: "starbase-xyz",
          agentType: "Starbase",
          title: "Starbase Session",
          updatedAt: "2025-01-15T10:00:00Z",
          workspaceId: "w1"
        }
      ],
      [
        {
          id: "w1",
          workspacePath: "/tmp/test-repo",
          branch: null
        }
      ]
    );
    
    const sessions = await scanConductorSessions({ homeDir });
    expect(sessions[0]?.harness).toBe("claude");
  });

  it("scanConductorSessions skips sessions with unknown agent_type", async () => {
    const homeDir = await createConductorFixture(
      [
        {
          id: "s1",
          claudeSessionId: "unknown-agent",
          agentType: "gpt-4",
          title: "Unknown Agent",
          updatedAt: "2025-01-15T10:00:00Z",
          workspaceId: "w1"
        },
        {
          id: "s2",
          claudeSessionId: "claude-valid",
          agentType: "claude",
          title: "Valid Session",
          updatedAt: "2025-01-15T11:00:00Z",
          workspaceId: "w1"
        }
      ],
      [
        {
          id: "w1",
          workspacePath: "/tmp/test-repo",
          branch: "main"
        }
      ]
    );
    
    const sessions = await scanConductorSessions({ homeDir });
    expect(sessions.length).toBe(1);
    expect(sessions[0]?.nativeSessionId).toBe("claude-valid");
  });

  it("scanT3CodeSessions returns empty when DB does not exist", async () => {
    tempHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "jingler-test-"));
    const sessions = await scanT3CodeSessions({ homeDir: tempHomeDir });
    expect(sessions).toEqual([]);
  });

  it("scanT3CodeSessions reads sessions from state.sqlite", async () => {
    const homeDir = await createT3Fixture(
      [
        {
          threadId: "t1",
          projectId: "p1",
          title: "T3 Thread",
          branch: "feature",
          worktreePath: "/tmp/t3-worktree",
          updatedAt: "2025-01-15T10:00:00Z",
          deletedAt: null
        }
      ],
      [
        {
          projectId: "p1",
          workspaceRoot: "/tmp/t3-workspace"
        }
      ],
      [
        {
          threadId: "t1",
          providerName: "anthropic",
          providerSessionId: "t3-session-123"
        }
      ]
    );
    
    const sessions = await scanT3CodeSessions({ homeDir });
    expect(sessions.length).toBe(1);
    expect(sessions[0]).toMatchObject({
      source: "t3code",
      nativeSessionId: "t3-session-123",
      harness: "claude",
      cwd: "/tmp/t3-worktree",
      branch: "feature",
      title: "T3 Thread"
    });
  });

  it("scanT3CodeSessions falls back to workspace_root when worktree_path is null", async () => {
    const homeDir = await createT3Fixture(
      [
        {
          threadId: "t1",
          projectId: "p1",
          title: "T3 Thread",
          branch: "main",
          worktreePath: null,
          updatedAt: "2025-01-15T10:00:00Z",
          deletedAt: null
        }
      ],
      [
        {
          projectId: "p1",
          workspaceRoot: "/tmp/t3-workspace"
        }
      ],
      [
        {
          threadId: "t1",
          providerName: "anthropic",
          providerSessionId: "t3-session-456"
        }
      ]
    );
    
    const sessions = await scanT3CodeSessions({ homeDir });
    expect(sessions[0]?.cwd).toBe("/tmp/t3-workspace");
  });

  it("scanT3CodeSessions skips deleted threads", async () => {
    const homeDir = await createT3Fixture(
      [
        {
          threadId: "t1",
          projectId: "p1",
          title: "Deleted Thread",
          branch: "main",
          worktreePath: "/tmp/deleted",
          updatedAt: "2025-01-15T10:00:00Z",
          deletedAt: "2025-01-15T11:00:00Z"
        },
        {
          threadId: "t2",
          projectId: "p1",
          title: "Active Thread",
          branch: "main",
          worktreePath: "/tmp/active",
          updatedAt: "2025-01-15T10:00:00Z",
          deletedAt: null
        }
      ],
      [
        {
          projectId: "p1",
          workspaceRoot: "/tmp/t3-workspace"
        }
      ],
      [
        {
          threadId: "t1",
          providerName: "anthropic",
          providerSessionId: "deleted-session"
        },
        {
          threadId: "t2",
          providerName: "anthropic",
          providerSessionId: "active-session"
        }
      ]
    );
    
    const sessions = await scanT3CodeSessions({ homeDir });
    expect(sessions.length).toBe(1);
    expect(sessions[0]?.nativeSessionId).toBe("active-session");
  });

  it("scanT3CodeSessions skips sessions with unknown provider_name", async () => {
    const homeDir = await createT3Fixture(
      [
        {
          threadId: "t1",
          projectId: "p1",
          title: "Unknown Provider",
          branch: "main",
          worktreePath: "/tmp/unknown",
          updatedAt: "2025-01-15T10:00:00Z",
          deletedAt: null
        },
        {
          threadId: "t2",
          projectId: "p1",
          title: "Valid Provider",
          branch: "main",
          worktreePath: "/tmp/valid",
          updatedAt: "2025-01-15T10:00:00Z",
          deletedAt: null
        }
      ],
      [
        {
          projectId: "p1",
          workspaceRoot: "/tmp/t3-workspace"
        }
      ],
      [
        {
          threadId: "t1",
          providerName: "openai",
          providerSessionId: "unknown-provider"
        },
        {
          threadId: "t2",
          providerName: "anthropic",
          providerSessionId: "valid-provider"
        }
      ]
    );
    
    const sessions = await scanT3CodeSessions({ homeDir });
    expect(sessions.length).toBe(1);
    expect(sessions[0]?.nativeSessionId).toBe("valid-provider");
  });

  it("scanConductorSessions respects limit option", async () => {
    const homeDir = await createConductorFixture(
      [
        {
          id: "s1",
          claudeSessionId: "session1",
          agentType: "claude",
          title: "Session 1",
          updatedAt: "2025-01-15T10:00:00Z",
          workspaceId: "w1"
        },
        {
          id: "s2",
          claudeSessionId: "session2",
          agentType: "claude",
          title: "Session 2",
          updatedAt: "2025-01-15T11:00:00Z",
          workspaceId: "w1"
        },
        {
          id: "s3",
          claudeSessionId: "session3",
          agentType: "claude",
          title: "Session 3",
          updatedAt: "2025-01-15T12:00:00Z",
          workspaceId: "w1"
        }
      ],
      [
        {
          id: "w1",
          workspacePath: "/tmp/test-repo",
          branch: "main"
        }
      ]
    );
    
    const sessions = await scanConductorSessions({ homeDir, limit: 2 });
    expect(sessions.length).toBe(2);
  });
});
