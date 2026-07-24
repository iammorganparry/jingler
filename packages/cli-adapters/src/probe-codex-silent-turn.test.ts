import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const probePath = fileURLToPath(
  new URL("../scripts/probe-codex-silent-turn.ts", import.meta.url)
)

const closesStdinAfterInitialize = `
let buffer = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buffer += chunk
  const newline = buffer.indexOf("\\n")
  if (newline < 0) return
  const request = JSON.parse(buffer.slice(0, newline))
  process.stdin.destroy()
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }) + "\\n")
  setTimeout(() => process.exit(0), 100)
})
`

describe("probe-codex-silent-turn arguments", () => {
  it("accepts a flag-shaped --bin-arg value", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", probePath, "--bin-arg", "--config", "--help"],
      { encoding: "utf8" }
    )

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("--bin-arg <value>")
    expect(result.stderr).toBe("")
  })

  it("still rejects a missing value for ordinary options", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", probePath, "--model", "--help"],
      { encoding: "utf8" }
    )

    expect(result.status).toBe(64)
    expect(result.stderr).toContain("--model requires a value")
  })
})

describe("probe-codex-silent-turn transport failures", () => {
  it("handles EPIPE from a child that closes stdin", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        probePath,
        "--attempts",
        "1",
        "--timeout-ms",
        "1000",
        "--bin",
        process.execPath,
        "--bin-arg",
        "--eval",
        "--bin-arg",
        closesStdinAfterInitialize
      ],
      { encoding: "utf8", timeout: 5_000 }
    )

    expect(result.status).toBe(1)
    expect(result.error).toBeUndefined()
    expect(result.stderr).not.toContain("Unhandled 'error' event")
    expect(result.stderr).not.toContain("Emitted 'error' event")
  })
})
