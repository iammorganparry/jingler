import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  boundedCodexStderr,
  createCodexAppServerDiagnostics,
  redactCodexDiagnosticText
} from "./codex-app-server-diagnostics.js"

const directories: string[] = []

afterEach(async () => {
  const { rm } = await import("node:fs/promises")
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe("Codex app-server diagnostics", () => {
  it("redacts credential-shaped stderr before persistence", () => {
    expect(
      redactCodexDiagnosticText(
        // biome-ignore lint/security/noSecrets: Deliberately fake credentials exercise the redactor.
        'session_id="eyJabcdefghij.abcdefghij.abcdefghij" Authorization: Bearer eyJabcdefghij.abcdefghij.abcdefghij sk-abcdefghijklmnop'
      )
    ).toBe('session_id="[REDACTED]" Authorization: "[REDACTED]" [REDACTED_TOKEN]')
  })

  it("bounds stderr after redaction", () => {
    const rendered = boundedCodexStderr(`${`sk-${"a".repeat(100)}`} ${"x".repeat(4_050)}`)
    expect(rendered.length).toBeLessThanOrEqual(4_096)
    expect(rendered).not.toContain("a".repeat(16))
  })

  it("writes protocol metadata into the configured directory", async () => {
    const directory = mkdtempSync(join(tmpdir(), "starbase-codex-diagnostics-"))
    directories.push(directory)
    const diagnostics = createCodexAppServerDiagnostics(
      directory,
      {
        sessionId: "s1",
        model: "gpt-5.6-sol",
        reasoningEffort: "medium"
      },
      () => new Date("2026-07-24T12:00:00.000Z")
    )
    expect(diagnostics).not.toBeNull()
    diagnostics?.record("request.sent", {
      method: "turn/start",
      requestId: 3
    })
    diagnostics?.close()
    await new Promise((resolve) => setTimeout(resolve, 10))

    const lines = readFileSync(join(directory, "codex-app-server-2026-07-24.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(lines).toStrictEqual([
      {
        timestamp: "2026-07-24T12:00:00.000Z",
        event: "request.sent",
        sessionId: "s1",
        model: "gpt-5.6-sol",
        reasoningEffort: "medium",
        method: "turn/start",
        requestId: 3
      }
    ])
    expect(JSON.stringify(lines)).not.toContain("prompt")
  })

  it("stays disabled when no development directory is configured", () => {
    expect(
      createCodexAppServerDiagnostics(undefined, {
        sessionId: "s1",
        model: null,
        reasoningEffort: null
      })
    ).toBeNull()
  })
})
