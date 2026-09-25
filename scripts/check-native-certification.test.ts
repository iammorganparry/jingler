import { describe, expect, it } from "vitest"
import { validateNativeCertifications } from "./check-native-certification.mjs"

const commit = "a".repeat(40)
const matrix = { claude: { minimum: "2.1.282" }, codex: { minimum: "0.153.2" }, opencode: { minimum: "1.18.14" } }
const records = () => Object.entries(matrix).flatMap(([runtime, config]) => ["minimum", "current"].map(version => ({
  schemaVersion: 1, commit, runtime, version, cliVersion: config.minimum, status: "passed",
  checks: ["discovery", "prompt", "resume"], timestamp: "2026-09-25T00:00:00.000Z"
})))

describe("native release artifact gate", () => {
  it("requires the complete successful same-commit matrix", () => {
    expect(() => validateNativeCertifications(records(), commit, matrix)).not.toThrow()
    expect(() => validateNativeCertifications(records().slice(1), commit, matrix)).toThrow()
    expect(() => validateNativeCertifications(records(), "b".repeat(40), matrix)).toThrow()
    const duplicate = records(); duplicate[1] = duplicate[0]!
    expect(() => validateNativeCertifications(duplicate, commit, matrix)).toThrow()
  })
  it.each([
    { status: "failed" }, { cliVersion: "unknown" }, { cliVersion: "0.0.0" },
    { checks: ["discovery"] }, { token: "secret" }, { timestamp: "invalid" }, { schemaVersion: 2 }
  ])("rejects incomplete, foreign or secret-bearing evidence (%#)", patch => {
    const values = records()
    expect(() => validateNativeCertifications([{ ...values[0], ...patch }, ...values.slice(1)], commit, matrix)).toThrow()
  })
})
