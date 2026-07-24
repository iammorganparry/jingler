import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const probePath = fileURLToPath(
  new URL("../scripts/probe-codex-silent-turn.mjs", import.meta.url)
)

describe("probe-codex-silent-turn arguments", () => {
  it("accepts a flag-shaped --bin-arg value", () => {
    const result = spawnSync(
      process.execPath,
      [probePath, "--bin-arg", "--config", "--help"],
      { encoding: "utf8" }
    )

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("--bin-arg <value>")
    expect(result.stderr).toBe("")
  })

  it("still rejects a missing value for ordinary options", () => {
    const result = spawnSync(
      process.execPath,
      [probePath, "--model", "--help"],
      { encoding: "utf8" }
    )

    expect(result.status).toBe(64)
    expect(result.stderr).toContain("--model requires a value")
  })
})
