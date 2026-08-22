import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { AgentToolExecutionContext } from "@jingler/plugin-sdk/host"
import { afterEach, describe, expect, it } from "vitest"
import { DEBUG_ACTIONS, type DebugInput } from "./contracts.js"
import { DebugController } from "./controller.js"
import { DapSession } from "./dap/session.js"
import type { DapResolvedAdapter } from "./dap/types.js"

const DAP_PORT_ARGUMENT = String.raw`\${port}`
const adapterPath = fileURLToPath(new URL("./fixtures/fake-dap-adapter.mjs", import.meta.url))
const sessions: DapSession[] = []
afterEach(async () => {
  delete process.env.FAKE_DAP_VARIABLES_FAIL_AT
  await Promise.all(sessions.splice(0).map((session) => session.dispose()))
})

const fakeAdapter = (): DapResolvedAdapter => ({
  name: "fake", command: process.execPath, commandPath: process.execPath,
  args: [adapterPath], languages: ["javascript"], fileTypes: [".js"], rootMarkers: [],
  launchDefaults: {}, attachDefaults: {}, acceptsDirectoryProgram: false
})

const waitFor = async (predicate: () => boolean | Promise<boolean>): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("condition timed out")
}

describe("DAP session", () => {
  it("launches, inspects, steps, evaluates, and terminates", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-debug-"))
    const program = join(root, "program.js")
    await writeFile(program, "let count = 3\n")
    process.env.FAKE_DAP_SOURCE = program
    const session = await DapSession.launch({ adapter: fakeAdapter(), cwd: root, program })
    sessions.push(session)
    await waitFor(() => session.snapshot().status === "stopped" && session.snapshot().frame !== undefined)
    expect(session.snapshot()).toMatchObject({ status: "stopped", frame: { line: 3 } })
    expect(await session.scopes()).toEqual([{ name: "Locals", variablesReference: 20, expensive: false }])
    expect(await session.variables(20)).toMatchObject([{ name: "count", value: "3" }])
    expect(await session.evaluate("count", undefined, "hover")).toMatchObject({ result: "3", type: "number" })
    expect(await session.setSourceBreakpoint(program, 7)).toMatchObject([{ verified: true, line: 7 }])
    await session.continue("next")
    expect(session.snapshot().frame?.line).toBe(4)
    await session.terminate()
    expect(session.snapshot().status).toBe("terminated")
  })

  it("connects to TCP adapters", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-debug-tcp-"))
    const program = join(root, "program.js")
    await writeFile(program, "let count = 3\n")
    process.env.FAKE_DAP_SOURCE = program
    const adapter = { ...fakeAdapter(), connectMode: "tcp" as const, args: [adapterPath, "--port", DAP_PORT_ARGUMENT] }
    const session = await DapSession.launch({ adapter, cwd: root, program })
    sessions.push(session)
    await waitFor(() => session.snapshot().status === "stopped")
    expect(session.snapshot().adapter).toBe("fake")
  })
})

describe("Debug controller", () => {
  it("keeps sessions isolated and bounds action history", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-debug-controller-"))
    const program = join(root, "program.js")
    await writeFile(program, "let count = 3\n")
    await mkdir(join(root, ".jingler"))
    await writeFile(join(root, ".jingler", "dap.json"), JSON.stringify({ adapters: { fake: {
      command: process.execPath, args: [adapterPath], fileTypes: [".js"], launchDefaults: {}
    } } }))
    process.env.FAKE_DAP_SOURCE = program
    process.env.FAKE_DAP_VARIABLES_FAIL_AT = "5"
    const controller = new DebugController()
    const context = (id: string): AgentToolExecutionContext => ({
      signal: new AbortController().signal,
      session: { id, repository: { name: "repo", path: root } }
    })
    await controller.execute({ action: "launch", program, adapter: "fake" }, context("one"))
    await waitFor(async () => (await controller.snapshot("one")).session?.status === "stopped")
    const first = await controller.snapshot("one")
    expect(first.session).not.toBeNull()
    expect(first.variables[20]?.[0]?.value).toBe("3")
    await controller.control({ sessionId: "one", action: "step_over" })
    expect((await controller.snapshot("one")).variables[20]?.[0]?.value).toBe("4")
    await controller.control({ sessionId: "one", action: "step_over" })
    expect((await controller.snapshot("one")).variables[20]).toBeUndefined()
    expect((await controller.snapshot("two")).session).toBeNull()
    await expect(controller.control({ sessionId: "two", action: "continue" })).rejects.toThrow("No debugger")
    await controller.dispose()
  })

  it("declares the complete upstream action set", () => {
    expect(DEBUG_ACTIONS).toHaveLength(28)
    expect(DEBUG_ACTIONS).toEqual(expect.arrayContaining([
      "launch", "attach", "set_breakpoint", "set_instruction_breakpoint",
      "data_breakpoint_info", "continue", "step_over", "evaluate", "stack_trace",
      "variables", "disassemble", "read_memory", "write_memory", "modules",
      "loaded_sources", "custom_request", "output", "terminate", "sessions"
    ] satisfies DebugInput["action"][]))
  })
})
