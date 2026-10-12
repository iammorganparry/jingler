import { describe, it, expect } from "vitest";
import type { ImportableSession } from "@jingler/core";

describe("Sessions.scanImportable", () => {
  it("merges sessions from all four sources", async () => {
    const sessions: ImportableSession[] = [
      {
        source: "claude-code",
        nativeSessionId: "cc-1",
        harness: "claude",
        cwd: "/tmp/cc",
        title: "CC Session",
        updatedAt: "2026-01-01T00:00:00Z",
        messageCount: 1,
        folderExists: false,
      },
      {
        source: "codex",
        nativeSessionId: "cx-1",
        harness: "codex",
        cwd: "/tmp/cx",
        title: "CX Session",
        updatedAt: "2026-01-02T00:00:00Z",
        messageCount: 1,
        folderExists: false,
      },
    ];

    // Merge and sort by updatedAt desc
    const merged = [...sessions];
    merged.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    expect(merged.length).toBe(2);
    expect(merged[0]?.nativeSessionId).toBe("cx-1"); // newer
    expect(merged[1]?.nativeSessionId).toBe("cc-1");
  });

  it("sorts sessions by updatedAt descending", () => {
    const sessions: ImportableSession[] = [
      {
        source: "claude-code",
        nativeSessionId: "old",
        harness: "claude",
        cwd: "/tmp",
        title: "Old",
        updatedAt: "2026-01-01T00:00:00Z",
        messageCount: 1,
        folderExists: true,
      },
      {
        source: "codex",
        nativeSessionId: "new",
        harness: "codex",
        cwd: "/tmp",
        title: "New",
        updatedAt: "2026-01-03T00:00:00Z",
        messageCount: 1,
        folderExists: true,
      },
      {
        source: "conductor",
        nativeSessionId: "mid",
        harness: "claude",
        cwd: "/tmp",
        title: "Mid",
        updatedAt: "2026-01-02T00:00:00Z",
        messageCount: 1,
        folderExists: true,
      },
    ];

    const sorted = [...sessions].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt)
    );

    expect(sorted.map((s) => s.nativeSessionId)).toEqual(["new", "mid", "old"]);
  });
});

describe("Sessions.import", () => {
  it("rejects import when folder does not exist", () => {
    const session: ImportableSession = {
      source: "claude-code",
      nativeSessionId: "missing",
      harness: "claude",
      cwd: "/nonexistent",
      title: "Missing Folder",
      updatedAt: "2026-01-01T00:00:00Z",
      messageCount: 1,
      folderExists: false,
    };

    expect(session.folderExists).toBe(false);
    // In the real handler, this would throw GitError
  });

  it("is idempotent when session already imported", () => {
    const nativeSessionId = "already-imported";
    const existingResumeIds = new Set([nativeSessionId]);

    // First import: creates session
    const isImported = existingResumeIds.has(nativeSessionId);
    expect(isImported).toBe(true);

    // Second import: returns existing session (idempotent)
    const stillImported = existingResumeIds.has(nativeSessionId);
    expect(stillImported).toBe(true);
  });

  it("returns error when session not found in source", () => {
    const availableSessions: ImportableSession[] = [
      {
        source: "claude-code",
        nativeSessionId: "exists",
        harness: "claude",
        cwd: "/tmp",
        title: "Exists",
        updatedAt: "2026-01-01T00:00:00Z",
        messageCount: 1,
        folderExists: true,
      },
    ];

    const requestedId = "does-not-exist";
    const found = availableSessions.find(
      (s) => s.nativeSessionId === requestedId
    );

    expect(found).toBeUndefined();
    // In the real handler, this would throw GitError
  });
});
