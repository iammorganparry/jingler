import type { ImportableSession } from "@jingler/core";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

interface ScanOptions {
  /** Home directory (defaults to process.env.HOME, overridable for tests). */
  homeDir?: string;
  /** Max sessions to return (default: no limit). */
  limit?: number;
}

// biome-ignore lint/suspicious/noExplicitAny: undocumented third-party JSONL, every field is read defensively
type Json = Record<string, any>;

interface Draft {
  sessionId?: string;
  cwd?: string;
  branch?: string;
  title?: string;
  updatedAt?: string;
  messageCount: number;
}

const exists = (p: string) =>
  fs.access(p).then(
    () => true,
    () => false
  );

const firstLine = (text: string) => (text.split("\n")[0] ?? "").slice(0, 60).trim();

/** Streams a JSONL file, skipping blank and unparseable lines. */
async function* jsonLines(filePath: string): AsyncGenerator<Json> {
  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === "object") yield value;
    } catch {
      // Undocumented third-party format: skip lines we can't parse.
    }
  }
}

async function parseSession(
  filePath: string,
  apply: (draft: Draft, line: Json) => void,
  meta: Pick<ImportableSession, "source" | "harness">
): Promise<ImportableSession | null> {
  const draft: Draft = { messageCount: 0 };
  for await (const line of jsonLines(filePath)) apply(draft, line);
  if (!(draft.sessionId && draft.cwd)) return null;
  return {
    ...meta,
    nativeSessionId: draft.sessionId,
    cwd: draft.cwd,
    branch: draft.branch,
    title: draft.title ?? "Untitled session",
    updatedAt: draft.updatedAt ?? new Date().toISOString(),
    messageCount: draft.messageCount,
    folderExists: await exists(draft.cwd)
  };
}

async function scanDir(
  root: string,
  parse: (file: string) => Promise<ImportableSession | null>,
  limit?: number
): Promise<ImportableSession[]> {
  if (!(await exists(root))) return [];
  const files = (await fs.readdir(root, { recursive: true })).filter((f) => f.endsWith(".jsonl")).sort();
  const sessions: ImportableSession[] = [];
  for (const file of files) {
    // biome-ignore lint/performance/noAwaitInLoops: sequential keeps memory flat and honours `limit`
    const session = await parse(path.join(root, file)).catch(() => null);
    if (!session) continue;
    sessions.push(session);
    if (limit && sessions.length >= limit) break;
  }
  return sessions;
}

// Claude Code: user lines carry sessionId, cwd, gitBranch, timestamp. Content is a
// string or an array of blocks; tool_result blocks are tool output, not user turns.
function claudeUserText(line: Json): string | null {
  const content = line.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || content.some((b) => b?.type === "tool_result")) return null;
  const text = content.find((b) => b?.type === "text")?.text;
  return typeof text === "string" ? text : null;
}

function applyClaudeLine(draft: Draft, line: Json): void {
  draft.sessionId ??= line.sessionId;
  draft.cwd ??= line.cwd;
  draft.branch ??= line.gitBranch || undefined;
  if (line.timestamp) draft.updatedAt = line.timestamp;
  if (line.type !== "user") return;
  const text = claudeUserText(line);
  if (text === null) return;
  draft.messageCount++;
  draft.title ??= firstLine(text) || undefined;
}

// Codex: first line is session_meta (payload.id, cwd, git.branch); user turns are
// response_item messages, the first of which is often <environment_context> boilerplate.
function applyCodexLine(draft: Draft, line: Json): void {
  const payload = line.payload;
  if (line.timestamp) draft.updatedAt = line.timestamp;
  if (line.type === "session_meta" && payload) {
    draft.sessionId = payload.id;
    draft.cwd = payload.cwd;
    draft.branch = payload.git?.branch ?? undefined;
    draft.updatedAt ??= payload.timestamp;
    return;
  }
  if (line.type !== "response_item" || payload?.type !== "message" || payload.role !== "user") return;
  const text = payload.content?.find((b: Json) => b?.type === "input_text")?.text;
  if (typeof text !== "string" || text.includes("<environment_context>")) return;
  draft.messageCount++;
  draft.title ??= firstLine(text) || undefined;
}

/** Claude Code sessions: ~/.claude/projects/<cwd-slug>/*.jsonl. */
export function scanClaudeCodeSessions(opts: ScanOptions = {}): Promise<ImportableSession[]> {
  const home = opts.homeDir ?? process.env.HOME;
  if (!home) return Promise.resolve([]);
  return scanDir(
    path.join(home, ".claude", "projects"),
    (f) => parseSession(f, applyClaudeLine, { source: "claude-code", harness: "claude" }),
    opts.limit
  );
}

/** Codex sessions: ~/.codex/sessions/YYYY/MM/DD/*.jsonl. */
export function scanCodexSessions(opts: ScanOptions = {}): Promise<ImportableSession[]> {
  const home = opts.homeDir ?? process.env.HOME;
  if (!home) return Promise.resolve([]);
  return scanDir(
    path.join(home, ".codex", "sessions"),
    (f) => parseSession(f, applyCodexLine, { source: "codex", harness: "codex" }),
    opts.limit
  );
}
