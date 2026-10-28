import type { ImportableSession } from "@jingler/core";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

interface ScanOptions {
  /** Home directory (defaults to process.env.HOME, overridable for tests). */
  homeDir?: string;
  /** Max sessions to return (default: no limit). */
  limit?: number;
}

const exists = (p: string) =>
  fs.access(p).then(
    () => true,
    () => false
  );

/**
 * Copy a SQLite database (plus -wal/-shm if present) to a temp directory,
 * then open the copy read-only. The live file may be locked.
 */
async function openDbReadOnly(dbPath: string): Promise<{ db: DatabaseSync; cleanup: () => Promise<void> }> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "jingler-import-"));
  const tempDbPath = path.join(tempDir, "db.sqlite");
  
  await fs.copyFile(dbPath, tempDbPath);
  
  // Copy -wal and -shm if present (SQLite write-ahead log)
  for (const suffix of ["-wal", "-shm"]) {
    const walPath = `${dbPath}${suffix}`;
    if (await exists(walPath)) {
      await fs.copyFile(walPath, `${tempDbPath}${suffix}`);
    }
  }
  
  const db = new DatabaseSync(tempDbPath);
  
  return {
    db,
    cleanup: async () => {
      db.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  };
}

// biome-ignore lint/suspicious/noExplicitAny: raw SQLite row
type DbRow = Record<string, any>;

function mapConductorAgentType(agentType: unknown): "claude" | "codex" | null {
  if (agentType === "claude" || agentType === "Starbase") return "claude";
  if (agentType === "codex" || agentType === "Codex") return "codex";
  return null;
}

function mapT3ProviderName(providerName: unknown): "claude" | "codex" | null {
  if (providerName === "anthropic" || providerName === "claude") return "claude";
  if (providerName === "codex") return "codex";
  return null;
}

async function conductorRowToSession(row: DbRow): Promise<ImportableSession | null> {
  const nativeSessionId = row.claude_session_id;
  const cwd = row.workspace_path;
  
  if (!(nativeSessionId && typeof nativeSessionId === "string" && cwd && typeof cwd === "string")) {
    return null;
  }
  
  const harness = mapConductorAgentType(row.agent_type);
  if (!harness) return null;
  
  return {
    source: "conductor",
    nativeSessionId,
    harness,
    cwd,
    branch: (row.branch && typeof row.branch === "string") ? row.branch : undefined,
    title: (row.title && typeof row.title === "string") ? row.title : "Untitled session",
    updatedAt: (row.updated_at && typeof row.updated_at === "string") ? row.updated_at : new Date().toISOString(),
    messageCount: 0,
    folderExists: await exists(cwd)
  };
}

async function t3RowToSession(row: DbRow): Promise<ImportableSession | null> {
  const nativeSessionId = row.provider_session_id;
  const worktreePath = row.worktree_path;
  const workspaceRoot = row.workspace_root;
  const cwd = worktreePath || workspaceRoot;
  
  if (!(nativeSessionId && typeof nativeSessionId === "string" && cwd && typeof cwd === "string")) {
    return null;
  }
  
  const harness = mapT3ProviderName(row.provider_name);
  if (!harness) return null;
  
  return {
    source: "t3code",
    nativeSessionId,
    harness,
    cwd,
    branch: (row.branch && typeof row.branch === "string") ? row.branch : undefined,
    title: (row.title && typeof row.title === "string") ? row.title : "Untitled session",
    updatedAt: (row.updated_at && typeof row.updated_at === "string") ? row.updated_at : new Date().toISOString(),
    messageCount: 0,
    folderExists: await exists(cwd)
  };
}

/** Conductor sessions: ~/Library/Application Support/com.conductor.app/conductor.db */
export async function scanConductorSessions(opts: ScanOptions = {}): Promise<ImportableSession[]> {
  const homeDir = opts.homeDir ?? process.env.HOME;
  if (!homeDir) return [];

  const dbPath = path.join(homeDir, "Library", "Application Support", "com.conductor.app", "conductor.db");
  if (!(await exists(dbPath))) return [];

  const { db, cleanup } = await openDbReadOnly(dbPath);
  try {
    const sessions: ImportableSession[] = [];
    
    const query = `
      SELECT 
        s.claude_session_id,
        s.agent_type,
        s.title,
        s.updated_at,
        w.workspace_path,
        w.branch
      FROM sessions s
      LEFT JOIN workspaces w ON s.workspace_id = w.id
      WHERE s.is_hidden = 0 AND s.claude_session_id IS NOT NULL
      ORDER BY s.updated_at DESC
    `;
    
    const rows = db.prepare(query).all() as DbRow[];
    
    for (const row of rows) {
      const session = await conductorRowToSession(row);
      if (session) {
        sessions.push(session);
        if (opts.limit && sessions.length >= opts.limit) break;
      }
    }
    
    return sessions;
  } finally {
    await cleanup();
  }
}

/** T3 Code sessions: ~/.t3/userdata/state.sqlite */
export async function scanT3CodeSessions(opts: ScanOptions = {}): Promise<ImportableSession[]> {
  const homeDir = opts.homeDir ?? process.env.HOME;
  if (!homeDir) return [];

  const dbPath = path.join(homeDir, ".t3", "userdata", "state.sqlite");
  if (!(await exists(dbPath))) return [];

  const { db, cleanup } = await openDbReadOnly(dbPath);
  try {
    const sessions: ImportableSession[] = [];
    
    const query = `
      SELECT 
        t.thread_id,
        t.title,
        t.branch,
        t.worktree_path,
        t.updated_at,
        p.workspace_root,
        s.provider_name,
        s.provider_session_id
      FROM projection_threads t
      LEFT JOIN projection_projects p ON t.project_id = p.project_id
      LEFT JOIN projection_thread_sessions s ON t.thread_id = s.thread_id
      WHERE t.deleted_at IS NULL
      ORDER BY t.updated_at DESC
    `;
    
    const rows = db.prepare(query).all() as DbRow[];
    
    for (const row of rows) {
      const session = await t3RowToSession(row);
      if (session) {
        sessions.push(session);
        if (opts.limit && sessions.length >= opts.limit) break;
      }
    }
    
    return sessions;
  } finally {
    await cleanup();
  }
}
