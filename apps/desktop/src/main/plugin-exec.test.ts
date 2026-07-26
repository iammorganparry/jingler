/**
 * `ctx.exec`'s clamps and its truncation marker.
 *
 * Both were adversarial-review findings, and both are the shape of bug that
 * unit tests exist for: reachable from a plugin, invisible in the happy path,
 * and presenting as something else entirely (a "hang", a JSON parse error).
 *
 * Real subprocesses rather than a mocked `spawn`. The whole point of this module
 * is the interaction between a timer, two streams and a child's exit, and a fake
 * `spawn` would be a test of the fake.
 */
import { describe, expect, it } from "vitest"
import { clampTimeout, runShell } from "./plugin-exec.js"

const node = process.execPath

/** Run a snippet of JS in a child, the way a plugin would run any binary. */
const run = (script: string, over: Record<string, unknown> = {}) =>
  runShell(
    { command: node, args: ["-e", script], ...over } as Parameters<typeof runShell>[0],
    undefined
  )

describe("timeoutMs clamping", () => {
  it("treats 0 as unset rather than killing on the next tick", async () => {
    // The bug: `Math.min(0, DEFAULT)` is 0, so the SIGKILL timer fired before the
    // child had produced anything. A plugin passing a config value that parsed to
    // 0 saw every command die instantly with a timeout it never asked for.
    const reply = await run("console.log('alive')", { timeoutMs: 0 })
    expect(reply.stdout.trim()).toBe("alive")
    expect(reply.code).toBe(0)
  })

  it("treats a negative the same way", async () => {
    const reply = await run("console.log('alive')", { timeoutMs: -5000 })
    expect(reply.stdout.trim()).toBe("alive")
  })

  it("resolves 0 and negatives to the default, not to a 1ms floor", () => {
    // A floor would satisfy the letter of "don't fire immediately" and change
    // nothing: spawning a process takes longer than 1ms, so the kill still wins.
    expect(clampTimeout(0)).toBe(120_000)
    expect(clampTimeout(-5_000)).toBe(120_000)
  })

  it("still honours a short timeout that was meant", async () => {
    await expect(
      run("setTimeout(() => {}, 10_000)", { timeoutMs: 150 })
    ).rejects.toThrow(/killed after 150ms/)
  })

  it("caps an over-ceiling ask at the default instead of honouring it", () => {
    // The reviewer's other half: a plugin asking for 300_000 gets 120_000 and no
    // error. That is deliberate — an unbounded child outlives the tab that asked
    // for it — but it is now documented on `ExecOptions.timeoutMs` rather than
    // being a surprise that reads as a hang.
    expect(clampTimeout(300_000)).toBe(120_000)
    expect(clampTimeout(120_001)).toBe(120_000)
  })

  it("keeps a value inside the range exactly as asked", () => {
    expect(clampTimeout(5_000)).toBe(5_000)
  })

  it("falls back to the default for undefined and NaN", () => {
    // NaN is the shape a parsed-from-config timeout takes when the config is
    // wrong: `Math.min(NaN, x)` is NaN, and `setTimeout(fn, NaN)` fires
    // immediately — the same instant-kill as 0, by a different route.
    expect(clampTimeout(undefined)).toBe(120_000)
    expect(clampTimeout(Number.NaN)).toBe(120_000)
  })
})

describe("truncation markers", () => {
  // 8 MiB per stream is the cap. Write comfortably past it on ONE stream and
  // assert the other comes back clean.
  const CHATTY_STDERR = `
    const chunk = "e".repeat(1024 * 1024)
    for (let i = 0; i < 10; i++) process.stderr.write(chunk)
    process.stdout.write(JSON.stringify({ ok: true }))
  `

  it("does not append stdout's marker when it was stderr that overflowed", async () => {
    // The bug: one shared \`truncated\` flag, marker appended only to stdout. A
    // command with a chatty stderr and a small valid JSON stdout came back with
    // "\\n… output truncated" glued to the JSON, so \`JSON.parse(result.stdout)\`
    // — the pattern the bundled github-issues plugin uses — threw on a command
    // that had succeeded.
    const reply = await run(CHATTY_STDERR)
    expect(() => JSON.parse(reply.stdout)).not.toThrow()
    expect(JSON.parse(reply.stdout)).toEqual({ ok: true })
    expect(reply.stdout).not.toContain("output truncated")
  }, 30_000)

  it("marks the stream that actually truncated", async () => {
    const reply = await run(CHATTY_STDERR)
    expect(reply.stderr).toContain("output truncated")
  }, 30_000)

  it("marks stdout when stdout is the one that overflows", async () => {
    const reply = await run(`
      const chunk = "o".repeat(1024 * 1024)
      for (let i = 0; i < 10; i++) process.stdout.write(chunk)
    `)
    expect(reply.stdout).toContain("output truncated")
    expect(reply.stderr).toBe("")
  }, 30_000)
})
