import { PassThrough } from "node:stream"
import { describe, expect, it } from "vitest"
import { CodexAppServerConnection } from "./codex-app-server-client.js"

const harness = (requestTimeoutMs?: number) => {
  const clientInput = new PassThrough()
  const clientOutput = new PassThrough()
  const sent: Array<Record<string, unknown>> = []
  const diagnostics: Array<{
    event: string
    fields: Readonly<Record<string, unknown>>
  }> = []
  let buffer = ""
  clientInput.on("data", (chunk: Buffer) => {
    buffer += chunk.toString()
    for (;;) {
      const newline = buffer.indexOf("\n")
      if (newline < 0) break
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.length > 0) {
        const parsed: unknown = JSON.parse(line)
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          sent.push(Object.fromEntries(Object.entries(parsed)))
        }
      }
    }
  })
  const connection = new CodexAppServerConnection(
    clientInput,
    clientOutput,
    () => {
      clientInput.end()
      clientOutput.end()
    },
    {
      ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
      diagnostics: {
        path: "/tmp/codex-diagnostics.jsonl",
        record: (event, fields = {}) => diagnostics.push({ event, fields }),
        close: () => undefined
      }
    }
  )
  return { connection, diagnostics, output: clientOutput, sent }
}

describe("CodexAppServerConnection", () => {
  it("correlates responses without leaking them into the notification queue", async () => {
    const { connection, output, sent } = harness()
    const request = connection.request("thread/start", { cwd: "/repo" })
    expect(sent[0]).toMatchObject({ id: 1, method: "thread/start" })

    output.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { thread: { id: "t1" } } })}\n`)
    await expect(request).resolves.toStrictEqual({ thread: { id: "t1" } })

    output.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "t1" } })}\n`
    )
    await expect(connection.nextMessage()).resolves.toMatchObject({
      method: "turn/started"
    })
    connection.close()
  })

  it("records protocol metadata without request or response contents", async () => {
    const { connection, diagnostics, output } = harness()
    const request = connection.request("turn/start", {
      prompt: "sensitive prompt"
    })
    output.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { secretOutput: "sensitive response" }
      })}\n`
    )
    await request
    output.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method: "item/completed",
        params: { output: "sensitive tool output" }
      })}\n`
    )
    await connection.nextMessage()

    expect(diagnostics.map(({ event }) => event)).toStrictEqual([
      "request.sent",
      "request.completed",
      "protocol.message"
    ])
    expect(JSON.stringify(diagnostics)).not.toContain("sensitive")
    expect(diagnostics.at(-1)?.fields).toMatchObject({
      method: "item/completed",
      serverRequest: false
    })
    connection.close()
  })

  it("drops an oversized unterminated line and resynchronizes on the next", async () => {
    const { connection, diagnostics, output } = harness()
    // A single JSON-RPC line beyond the 64 MB ceiling, arriving with no newline —
    // e.g. a command_execution whose aggregated_output dumped a huge transcript.
    // It must be discarded, not buffered, so the heap never grows without bound.
    output.write(`{"jsonrpc":"2.0","method":"item/completed","params":{"x":"${"a".repeat(33 * 1024 * 1024)}`)
    output.write("b".repeat(33 * 1024 * 1024))

    // The next complete message must still be delivered after resync.
    output.write(
      `\n${JSON.stringify({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "t1" } })}\n`
    )
    await expect(connection.nextMessage()).resolves.toMatchObject({ method: "turn/started" })
    expect(diagnostics.some(({ event }) => event === "protocol.oversized_line")).toBe(true)
    connection.close()
  })

  it("preserves notification and server-request ordering", async () => {
    const { connection, output } = harness()
    output.write(
      [
        JSON.stringify({
          jsonrpc: "2.0",
          method: "thread/tokenUsage/updated",
          params: { threadId: "t1" }
        }),
        JSON.stringify({
          jsonrpc: "2.0",
          id: "approval-1",
          method: "item/fileChange/requestApproval",
          params: {}
        })
      ].join("\n") + "\n"
    )

    await expect(connection.nextMessage()).resolves.toMatchObject({
      method: "thread/tokenUsage/updated"
    })
    await expect(connection.nextMessage()).resolves.toMatchObject({
      id: "approval-1",
      method: "item/fileChange/requestApproval"
    })
    connection.close()
  })

  it("drains replay notifications without blocking for a future message", () => {
    const { connection, output } = harness()
    output.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "thread/tokenUsage/updated", params: { threadId: "t1" } })}\n`
    )
    expect(connection.drainMessages()).toStrictEqual([
      {
        jsonrpc: "2.0",
        method: "thread/tokenUsage/updated",
        params: { threadId: "t1" }
      }
    ])
    expect(connection.drainMessages()).toStrictEqual([])
    connection.close()
  })

  it("removes a timed-out notification waiter without stealing the next message", async () => {
    const { connection, output } = harness()

    await expect(connection.nextMessageWithin(5)).resolves.toBeNull()
    output.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "t1" } })}\n`
    )

    await expect(connection.nextMessage()).resolves.toMatchObject({
      method: "turn/started"
    })
    connection.close()
  })

  it("rejects a pending request when the transport closes", async () => {
    const { connection, output } = harness()
    const request = connection.request("turn/start", {})
    output.end()
    await expect(request).rejects.toThrow("Codex app-server closed")
  })

  it("rejects a request when a live transport never responds", async () => {
    const { connection } = harness(10)

    await expect(connection.request("initialize", {})).rejects.toThrow(
      'Codex app-server request "initialize" timed out after 10ms'
    )
    connection.close()
  })

  it("supports a shorter deadline for teardown requests", async () => {
    const { connection } = harness(30_000)

    await expect(connection.request("turn/interrupt", {}, { timeoutMs: 10 })).rejects.toThrow(
      'Codex app-server request "turn/interrupt" timed out after 10ms'
    )
    connection.close()
  })
})
