import { ImportableSession } from "@jingler/core";
import fs from "node:fs/promises";
import path from "node:path";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

/**
 * Scanner interface for discovering importable sessions from other apps.
 * Each scanner reads a specific app's session store format.
 */

interface ScanOptions {
  /** Home directory (defaults to process.env.HOME, overridable for tests). */
  homeDir?: string;
  /** Max sessions to return (default: no limit). */
  limit?: number;
}

/**
 * Scan Claude Code sessions from ~/.claude/projects.
 * Each project folder contains *.jsonl session files with one JSON object per line.
 */
export async function scanClaudeCodeSessions(
  opts: ScanOptions = {}
): Promise<ImportableSession[]> {
  const homeDir = opts.homeDir ?? process.env.HOME;
  if (!homeDir) return [];

  const projectsDir = path.join(homeDir, ".claude", "projects");
  try {
    await fs.access(projectsDir);
  } catch {
    return [];
  }

  const sessions: ImportableSession[] = [];
  const projectDirs = await fs.readdir(projectsDir, { withFileTypes: true });

  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue;

    const projectPath = path.join(projectsDir, dir.name);
    const files = await fs.readdir(projectPath);

    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;

      const sessionPath = path.join(projectPath, file);
      try {
        const session = await parseClaudeCodeSession(sessionPath);
        if (session) {
          sessions.push(session);
          if (opts.limit && sessions.length >= opts.limit) return sessions;
        }
      } catch {
        // Skip unparseable files
        continue;
      }
    }
  }

  return sessions;
}

async function parseClaudeCodeSession(
  filePath: string
): Promise<ImportableSession | null> {
  const rl = createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity,
  });

  let sessionId: string | null = null;
  let cwd: string | null = null;
  let branch: string | null = null;
  let title: string | null = null;
  let updatedAt: string | null = null;
  let messageCount = 0;

  for await (const line of rl) {
    if (!line.trim()) continue;

    try {
      const obj = JSON.parse(line);

      // Extract sessionId from any line that has it
      if (obj.sessionId && !sessionId) {
        sessionId = obj.sessionId;
      }

      // Extract cwd and branch from user message metadata
      if (obj.cwd && !cwd) {
        cwd = obj.cwd;
      }
      if (obj.gitBranch && !branch) {
        branch = obj.gitBranch;
      }

      // Extract title from first user message
      if (
        !title &&
        obj.type === "user" &&
        obj.message?.role === "user" &&
        obj.message?.content?.[0]?.text
      ) {
        const text = obj.message.content[0].text;
        // Take first 60 chars, stop at newline
        title = text.split("\n")[0].slice(0, 60).trim();
        messageCount++;
      } else if (obj.type === "user") {
        messageCount++;
      }

      // Track latest timestamp
      if (obj.timestamp) {
        updatedAt = obj.timestamp;
      }
    } catch {
      // Skip malformed JSON lines
      continue;
    }
  }

  if (!sessionId || !cwd) return null;

  const folderExists = await fs
    .access(cwd)
    .then(() => true)
    .catch(() => false);

  return {
    source: "claude-code",
    nativeSessionId: sessionId,
    harness: "claude",
    cwd,
    branch: branch ?? undefined,
    title: title ?? "Untitled session",
    updatedAt: updatedAt ?? new Date().toISOString(),
    messageCount,
    folderExists,
  };
}

/**
 * Scan Codex sessions from ~/.codex/sessions.
 * Sessions are organized as YYYY/MM/DD/*.jsonl with session_meta + messages.
 */
export async function scanCodexSessions(
  opts: ScanOptions = {}
): Promise<ImportableSession[]> {
  const homeDir = opts.homeDir ?? process.env.HOME;
  if (!homeDir) return [];

  const sessionsDir = path.join(homeDir, ".codex", "sessions");
  try {
    await fs.access(sessionsDir);
  } catch {
    return [];
  }

  const sessions: ImportableSession[] = [];

  // Walk YYYY/MM/DD structure
  const years = await fs.readdir(sessionsDir, { withFileTypes: true });
  for (const year of years) {
    if (!year.isDirectory()) continue;

    const yearPath = path.join(sessionsDir, year.name);
    const months = await fs.readdir(yearPath, { withFileTypes: true });

    for (const month of months) {
      if (!month.isDirectory()) continue;

      const monthPath = path.join(yearPath, month.name);
      const days = await fs.readdir(monthPath, { withFileTypes: true });

      for (const day of days) {
        if (!day.isDirectory()) continue;

        const dayPath = path.join(monthPath, day.name);
        const files = await fs.readdir(dayPath);

        for (const file of files) {
          if (!file.endsWith(".jsonl")) continue;

          const sessionPath = path.join(dayPath, file);
          try {
            const session = await parseCodexSession(sessionPath);
            if (session) {
              sessions.push(session);
              if (opts.limit && sessions.length >= opts.limit) return sessions;
            }
          } catch {
            continue;
          }
        }
      }
    }
  }

  return sessions;
}

async function parseCodexSession(
  filePath: string
): Promise<ImportableSession | null> {
  const rl = createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity,
  });

  let sessionId: string | null = null;
  let cwd: string | null = null;
  let branch: string | null = null;
  let title: string | null = null;
  let updatedAt: string | null = null;
  let messageCount = 0;

  for await (const line of rl) {
    if (!line.trim()) continue;

    try {
      const obj = JSON.parse(line);

      // First line should be session_meta
      if (obj.type === "session_meta" && obj.payload) {
        sessionId = obj.payload.id;
        cwd = obj.payload.cwd;
        branch = obj.payload.git?.branch ?? null;
        updatedAt = obj.timestamp ?? obj.payload.timestamp;
      }

      // Extract title from first user message
      if (
        !title &&
        obj.type === "response_item" &&
        obj.payload?.type === "message" &&
        obj.payload?.role === "user" &&
        obj.payload?.content?.[0]?.type === "input_text"
      ) {
        const text = obj.payload.content[0].text;
        // Skip environment context boilerplate, find actual user text
        if (!text.includes("<environment_context>")) {
          title = text.split("\n")[0].slice(0, 60).trim();
          messageCount++;
        }
      } else if (
        obj.type === "response_item" &&
        obj.payload?.role === "user"
      ) {
        messageCount++;
      }

      if (obj.timestamp && !updatedAt) {
        updatedAt = obj.timestamp;
      }
    } catch {
      continue;
    }
  }

  if (!sessionId || !cwd) return null;

  const folderExists = await fs
    .access(cwd)
    .then(() => true)
    .catch(() => false);

  return {
    source: "codex",
    nativeSessionId: sessionId,
    harness: "codex",
    cwd,
    branch: branch ?? undefined,
    title: title ?? "Untitled session",
    updatedAt: updatedAt ?? new Date().toISOString(),
    messageCount,
    folderExists,
  };
}
