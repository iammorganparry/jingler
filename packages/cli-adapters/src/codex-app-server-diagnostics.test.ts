import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, expectTypeOf, it } from "vitest"
import {
  boundedCodexStderr,
  type CodexAppServerDiagnosticFields,
  createCodexAppServerDiagnostics,
  createCodexStderrRecorder,
  redactCodexDiagnosticText
} from "./codex-app-server-diagnostics.js"

const directories: string[] = []

afterEach(async () => {
  const { rm } = await import("node:fs/promises")
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

const recorderHarness = () => {
  const events: Array<{ event: string; fields: Readonly<Record<string, unknown>> }> = []
  const recorder = createCodexStderrRecorder({
    path: "/tmp/codex-diagnostics.jsonl",
    record: (event, fields = {}) => events.push({ event, fields }),
    close: () => undefined
  })
  return { events, recorder }
}

describe("Codex diagnostic redaction", () => {
  it("redacts credential-shaped stderr before persistence", () => {
    expect(
      redactCodexDiagnosticText(
        // biome-ignore lint/security/noSecrets: Deliberately fake credentials exercise the redactor.
        'session_id="eyJabcdefghij.abcdefghij.abcdefghij" Authorization: Bearer eyJabcdefghij.abcdefghij.abcdefghij sk-abcdefghijklmnop'
      )
    ).toBe('session_id="[REDACTED]" Authorization: "[REDACTED]" [REDACTED_TOKEN]')
  })

  it("redacts opaque bearer and refresh credentials", () => {
    expect(
      redactCodexDiagnosticText(
        "Authorization: Bearer opaque-secret access_token=access-secret refresh-token: refresh-secret"
      )
    ).toBe(
      // biome-ignore lint/security/noSecrets: Expected redaction markers, not credentials.
      'Authorization: "[REDACTED]" access_token="[REDACTED]" refresh-token: "[REDACTED]"'
    )
  })

  it("bounds stderr after redaction", () => {
    const rendered = boundedCodexStderr(`${`sk-${"a".repeat(100)}`} ${"x".repeat(4_050)}`)
    expect(rendered.length).toBeLessThanOrEqual(4_096)
    expect(rendered).not.toContain("a".repeat(16))
  })
})

describe("Codex stderr recorder", () => {
  it("redacts credentials split across stderr chunks", () => {
    const { events, recorder } = recorderHarness()

    recorder.append("Authorization: Bearer opaque-")
    expect(events).toStrictEqual([])
    recorder.append("secret\n")

    expect(events).toStrictEqual([
      {
        event: "process.stderr",
        fields: { text: 'Authorization: "[REDACTED]"' }
      }
    ])
  })

  it("omits an oversized line rather than persisting an unanchored fragment", () => {
    const { events, recorder } = recorderHarness()

    recorder.append(`sk-${"a".repeat(20_000)}`)
    recorder.append("\n")

    expect(events).toStrictEqual([
      {
        event: "process.stderr",
        fields: {
          text: "[stderr line omitted: exceeded 16384 characters]",
          truncated: true
        }
      }
    ])
  })
})

describe("Codex diagnostic persistence", () => {
  it("reserves trace envelope keys from event-specific fields", () => {
    expectTypeOf<{ event: string }>().not.toMatchTypeOf<CodexAppServerDiagnosticFields>()
    expectTypeOf<{ model: string }>().not.toMatchTypeOf<CodexAppServerDiagnosticFields>()
    expectTypeOf<{ method: string }>().toMatchTypeOf<CodexAppServerDiagnosticFields>()
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
