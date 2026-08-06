/**
 * `ctx.exec` — running a subprocess on a plugin's behalf.
 *
 * ## Why plugins go through main rather than calling `child_process` themselves
 *
 * They could. The extension host is Node and nothing stops it. The point is not
 * to prevent it but to make the supported path the observable one: everything
 * routed here is attributable to a plugin, can be logged, and has one place to
 * gain a refusal when the active repo is untrusted. A plugin that reaches around
 * this is doing something the operator cannot see, which is worth being able to
 * say plainly in the docs.
 *
 * ## Why the child is never given a shell
 *
 * `spawn` with an argv array, never `exec` with a string. A plugin passing a
 * repo name, a branch, or anything else derived from a file it just read into a
 * shell string is a command injection, and the injection would run with the
 * operator's own credentials. There is no shell to inject into here.
 */
import { spawn } from "node:child_process"
import type { ExecReply, ExecRequest } from "@jingler/cli-adapters"

/**
 * Hard ceiling on captured output PER STREAM, so a runaway process cannot
 * exhaust memory and a chatty stdout cannot starve stderr.
 */
const MAX_STREAM_BYTES = 8 * 1024 * 1024

/**
 * Default kill time, and the CEILING. A plugin can shorten it; it cannot raise
 * it or remove it — an unbounded child spawned by a plugin outlives the tab that
 * asked for it and is invisible to the operator. The cap is documented on
 * `ExecOptions.timeoutMs` in the SDK, because a plugin asking for 300_000 and
 * silently getting 120_000 is the kind of surprise that reads as a hang.
 */
const DEFAULT_TIMEOUT_MS = 120_000

/**
 * Resolve the kill time a request actually gets.
 *
 * `0`, a negative, and `NaN` all fall back to the DEFAULT rather than being
 * honoured. The old `Math.min(asked, DEFAULT)` passed them straight through, and
 * `setTimeout(kill, 0)` — or `setTimeout(kill, NaN)`, which is the same thing —
 * schedules the SIGKILL for the next tick: every command died instantly with a
 * timeout error nobody asked for. A config value that parsed to `0` or `NaN` is
 * the realistic way a plugin gets here.
 *
 * A floor of 1ms would satisfy the letter and change nothing — spawning a
 * process takes longer than that. The useful reading of every value at or below
 * zero is "unset", because no caller means "kill it before it starts".
 *
 * Exported so the ceiling can be asserted without a test that waits two minutes
 * for a child to be killed. "Assert it by living through it" is not a test
 * anyone keeps.
 */
export const clampTimeout = (asked: number | undefined): number =>
  asked === undefined || !Number.isFinite(asked) || asked <= 0
    ? DEFAULT_TIMEOUT_MS
    : Math.min(asked, DEFAULT_TIMEOUT_MS)

export const runShell = (
  request: ExecRequest,
  defaultCwd: string | undefined
): Promise<ExecReply> =>
  new Promise<ExecReply>((resolve, reject) => {
    const timeoutMs = clampTimeout(request.timeoutMs)

    const child = spawn(request.command, [...request.args], {
      cwd: request.cwd ?? defaultCwd,
      // Merged over the host's environment rather than replacing it: a plugin
      // that only wants to add one scoped environment value should not have to reconstruct PATH,
      // and getting PATH wrong is how "command not found" happens for a binary
      // that is plainly installed.
      env: { ...process.env, ...request.env },
      // No shell. See the note at the top of this file.
      shell: false
    })

    // Buffers, not strings, and a budget PER STREAM.
    //
    // The previous version summed `String.length` — UTF-16 code units, not
    // bytes, so a multibyte-heavy stream got well past the nominal cap — and
    // shared one budget across both, so a chatty stdout could starve stderr of
    // its entire allowance and swallow the error message explaining the failure.
    //
    // `truncated` is PER STREAM, and so is the marker. A single shared flag put
    // "… output truncated" on stdout when it was stderr that overflowed — so a
    // command with a chatty stderr and a small, valid JSON stdout came back with
    // the marker glued to the JSON, and `JSON.parse(result.stdout)` threw on a
    // command that had succeeded. That is the pattern the bundled github-issues
    // plugin uses, so the corruption was reachable from shipped code.
    const out: Buffer[] = []
    const err: Buffer[] = []
    let outBytes = 0
    let errBytes = 0
    let outTruncated = false
    let errTruncated = false
    let settled = false

    const capture = (chunk: Buffer, into: "out" | "err") => {
      const used = into === "out" ? outBytes : errBytes
      const markTruncated = () => {
        if (into === "out") outTruncated = true
        else errTruncated = true
      }
      if (used >= MAX_STREAM_BYTES) {
        markTruncated()
        return
      }
      // Trim the chunk rather than dropping it whole: the cap is a ceiling on
      // what is kept, and checking only before the append let one oversized
      // chunk through in full.
      const room = MAX_STREAM_BYTES - used
      const kept = chunk.byteLength > room ? chunk.subarray(0, room) : chunk
      if (kept.byteLength < chunk.byteLength) markTruncated()

      if (into === "out") {
        out.push(kept)
        outBytes += kept.byteLength
      } else {
        err.push(kept)
        errBytes += kept.byteLength
      }
    }

    child.stdout?.on("data", (chunk: Buffer) => capture(chunk, "out"))
    child.stderr?.on("data", (chunk: Buffer) => capture(chunk, "err"))

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill("SIGKILL")
      reject(new Error(`\`${request.command}\` was killed after ${timeoutMs}ms`))
    }, timeoutMs)

    child.on("error", (cause) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Spawn failures — not found, not executable — throw. A process that RUNS
      // and exits non-zero resolves with its code instead, because "the command
      // said no" is an answer and "there is no such command" is not.
      reject(new Error(`could not run \`${request.command}\`: ${cause.message}`))
    })

    child.on("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const stdout = Buffer.concat(out).toString("utf8")
      const stderr = Buffer.concat(err).toString("utf8")
      resolve({
        stdout: outTruncated ? `${stdout}\n… output truncated` : stdout,
        stderr: errTruncated ? `${stderr}\n… output truncated` : stderr,
        code: code ?? 0
      })
    })

    if (request.input !== undefined) {
      child.stdin?.end(request.input)
    } else {
      // Closed rather than left open: a child that reads stdin would otherwise
      // block forever waiting for input that is never coming, and present as a
      // plugin command that simply never returns.
      child.stdin?.end()
    }
  })
