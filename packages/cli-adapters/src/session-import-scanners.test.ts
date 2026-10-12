import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  scanClaudeCodeSessions,
  scanCodexSessions,
} from "./session-import-scanners.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "__fixtures__", "import");

describe("scanClaudeCodeSessions", () => {
  it("returns empty array when home dir doesn't exist", async () => {
    const sessions = await scanClaudeCodeSessions({
      homeDir: "/nonexistent",
    });
    expect(sessions).toEqual([]);
  });

  it("returns empty array when .claude/projects doesn't exist", async () => {
    const sessions = await scanClaudeCodeSessions({
      homeDir: "/tmp",
    });
    expect(sessions).toEqual([]);
  });

  it("scans valid Claude Code session", async () => {
    const sessions = await scanClaudeCodeSessions({
      homeDir: fixturesDir,
    });

    expect(sessions.length).toBeGreaterThanOrEqual(1);
    const validSession = sessions.find(
      (s) => s.nativeSessionId === "test-session-id"
    );
    expect(validSession).toBeDefined();
    expect(validSession).toMatchObject({
      source: "claude-code",
      nativeSessionId: "test-session-id",
      harness: "claude",
      cwd: "/tmp/test-project",
      branch: "feat/test-feature",
      title: "Add a test feature to the app",
      messageCount: 1,
      folderExists: false, // /tmp/test-project doesn't exist
    });
  });

  it("skips files with invalid JSON", async () => {
    const sessions = await scanClaudeCodeSessions({
      homeDir: fixturesDir,
    });
    // Should not crash, just skip the truncated file
    expect(sessions.some((s) => s.nativeSessionId === "truncated-id")).toBe(
      false
    );
  });

  it("skips files missing required fields", async () => {
    const sessions = await scanClaudeCodeSessions({
      homeDir: fixturesDir,
    });
    // no-id.jsonl has no sessionId or cwd, should be skipped
    expect(sessions.every((s) => s.nativeSessionId && s.cwd)).toBe(true);
  });

  it("respects limit option", async () => {
    const sessions = await scanClaudeCodeSessions({
      homeDir: fixturesDir,
      limit: 1,
    });
    expect(sessions.length).toBeLessThanOrEqual(1);
  });
});

describe("scanCodexSessions", () => {
  it("returns empty array when home dir doesn't exist", async () => {
    const sessions = await scanCodexSessions({
      homeDir: "/nonexistent",
    });
    expect(sessions).toEqual([]);
  });

  it("returns empty array when .codex/sessions doesn't exist", async () => {
    const sessions = await scanCodexSessions({
      homeDir: "/tmp",
    });
    expect(sessions).toEqual([]);
  });

  it("scans valid Codex session", async () => {
    const sessions = await scanCodexSessions({
      homeDir: fixturesDir,
    });

    expect(sessions.length).toBeGreaterThanOrEqual(1);
    const validSession = sessions.find(
      (s) => s.nativeSessionId === "test-codex-id"
    );
    expect(validSession).toBeDefined();
    expect(validSession).toMatchObject({
      source: "codex",
      nativeSessionId: "test-codex-id",
      harness: "codex",
      cwd: "/tmp/test-codex-project",
      branch: "main",
      title: "Fix the bug in the parser",
      messageCount: 1,
      folderExists: false, // /tmp/test-codex-project doesn't exist
    });
    expect(validSession?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("skips files missing session_meta", async () => {
    const sessions = await scanCodexSessions({
      homeDir: fixturesDir,
    });
    // no-meta.jsonl has no session_meta, should be skipped
    expect(sessions.every((s) => s.nativeSessionId && s.cwd)).toBe(true);
  });

  it("respects limit option", async () => {
    const sessions = await scanCodexSessions({
      homeDir: fixturesDir,
      limit: 1,
    });
    expect(sessions.length).toBeLessThanOrEqual(1);
  });
});
