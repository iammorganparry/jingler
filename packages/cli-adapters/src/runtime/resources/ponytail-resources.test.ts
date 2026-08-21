import { pathToFileURL } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import {
  PONYTAIL_EXTENSION_PATH,
  PONYTAIL_SKILLS_PATH,
  PONYTAIL_VERSION
} from "./ponytail-resources.js"

interface PonytailCommandResult {
  readonly type: string
  readonly mode?: string
}

interface PonytailModule {
  readonly default: (pi: PonytailApi) => void
  readonly parsePonytailCommand: (text: string, fallback?: string) => PonytailCommandResult
  readonly resolveSessionMode: (entries: ReadonlyArray<unknown>, fallback?: string) => string
}

type Handler = (event: unknown, context?: PonytailContext) => Promise<unknown>
interface PonytailContext {
  readonly sessionManager?: {
    readonly getBranch?: () => ReadonlyArray<unknown>
    readonly getEntries?: () => ReadonlyArray<unknown>
  }
  readonly ui?: {
    readonly setStatus?: (id: string, value: string) => void
    readonly notify?: (message: string, level: string) => void
  }
}
interface PonytailApi {
  readonly registerCommand: (
    name: string,
    command: { readonly handler: (args: string, context?: PonytailContext) => Promise<void> }
  ) => void
  readonly on: (event: string, handler: Handler) => void
  readonly appendEntry: (type: string, data: unknown) => void
  readonly sendUserMessage: (message: string, options?: unknown) => void
}

const originalDefault = process.env.PONYTAIL_DEFAULT_MODE
afterEach(() => {
  if (originalDefault === undefined) delete process.env.PONYTAIL_DEFAULT_MODE
  else process.env.PONYTAIL_DEFAULT_MODE = originalDefault
})

const loadPonytail = async (): Promise<PonytailModule> =>
  import(pathToFileURL(PONYTAIL_EXTENSION_PATH).href) as Promise<PonytailModule>

describe("bundled Ponytail resources", () => {
  it("pins the official package and all six skills", async () => {
    expect(PONYTAIL_VERSION).toBe("4.9.0")
    const { readdir } = await import("node:fs/promises")
    expect((await readdir(PONYTAIL_SKILLS_PATH)).sort()).toEqual([
      "ponytail",
      "ponytail-audit",
      "ponytail-debt",
      "ponytail-gain",
      "ponytail-help",
      "ponytail-review"
    ])
  })

  it("registers levels and injects the official ruleset", async () => {
    process.env.PONYTAIL_DEFAULT_MODE = "full"
    const ponytail = await loadPonytail()
    expect(ponytail.parsePonytailCommand("lite")).toMatchObject({ type: "set-mode", mode: "lite" })
    expect(ponytail.parsePonytailCommand("ultra")).toMatchObject({ type: "set-mode", mode: "ultra" })
    expect(ponytail.parsePonytailCommand("off")).toMatchObject({ type: "set-mode", mode: "off" })
    expect(ponytail.resolveSessionMode([
      { type: "custom", customType: "ponytail-mode", data: { mode: "ultra" } }
    ], "full")).toBe("ultra")

    const commands = new Map<string, { readonly handler: (args: string, context?: PonytailContext) => Promise<void> }>()
    const events = new Map<string, Handler>()
    const entries: Array<{ readonly type: string; readonly data: unknown }> = []
    ponytail.default({
      registerCommand: (name, command) => commands.set(name, command),
      on: (event, handler) => events.set(event, handler),
      appendEntry: (type, data) => entries.push({ type, data }),
      sendUserMessage: () => {}
    })

    expect([...commands.keys()].sort()).toEqual([
      "ponytail",
      "ponytail-audit",
      "ponytail-debt",
      "ponytail-gain",
      "ponytail-help",
      "ponytail-review"
    ])
    await events.get("session_start")?.({}, { sessionManager: { getBranch: () => [] } })
    const full = await events.get("before_agent_start")?.({ systemPrompt: "Jingler policy" })
    expect(full).toMatchObject({ systemPrompt: expect.stringContaining("lazy senior developer") })

    await commands.get("ponytail")?.handler("ultra")
    expect(entries.at(-1)).toEqual({ type: "ponytail-mode", data: { mode: "ultra" } })
    const ultra = await events.get("before_agent_start")?.({ systemPrompt: "Jingler policy" })
    expect(ultra).toMatchObject({ systemPrompt: expect.stringContaining("level: ultra") })

    await commands.get("ponytail")?.handler("off")
    expect(await events.get("before_agent_start")?.({ systemPrompt: "Jingler policy" })).toBeUndefined()
  })
})
