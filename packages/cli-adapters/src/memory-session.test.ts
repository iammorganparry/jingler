import { describe, expect, it } from "vitest"
import type { SessionSpec } from "./adapter.js"
import { EMPTY_MEMORY_RETRIEVAL_SUMMARY } from "./memory.js"
import { attachMemoryToSessionSpec } from "./memory-session.js"

const spec: SessionSpec = {
  cli: "codex",
  repo: "jingler",
  branch: "feature/memory-workers",
  cwd: "/tmp/jingler",
  prompt: "Implement the assigned stage.",
  images: [],
  binPath: "/usr/bin/codex",
  mode: "auto",
  model: "gpt-5.6-sol",
  resumeId: null
}

describe("attachMemoryToSessionSpec", () => {
  it("loads memory instructions and the MCP server into an independent worker", () => {
    const enriched = attachMemoryToSessionSpec(spec, {
      server: {
        name: "jingler-memory",
        url: "http://127.0.0.1:9000/mcp",
        headers: { authorization: "Bearer scoped" }
      },
      instructions: "<team-memory>Recall first.</team-memory>",
      retrieval: EMPTY_MEMORY_RETRIEVAL_SUMMARY
    })

    expect(enriched.prompt).toBe(
      "<team-memory>Recall first.</team-memory>\n\nImplement the assigned stage."
    )
    expect(enriched.remoteMcpServers?.map((server) => server.name)).toEqual([
      "jingler-memory"
    ])
  })

  it("preserves the original spec when memory is unavailable", () => {
    expect(attachMemoryToSessionSpec(spec, null)).toBe(spec)
  })
})
