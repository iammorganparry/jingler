import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { CodexModel } from "./codex-models.js"
import { fetchCodexModels, toModelOptions } from "./codex-models.js"

/**
 * The `model/list` → chip-option mapping is the pure seam (the stdio handshake
 * itself is verified against a real `codex` binary). Shapes below mirror an
 * actual response from codex-cli 0.144.1.
 */

const model = (over: Partial<CodexModel> & { id: string }): CodexModel => ({ ...over })

const fakeAppServers: Array<string> = []

const fakeModelServer = (
  pages: Readonly<Record<string, unknown>>,
  behavior: "pages" | "exit" | "hang" | "endless" = "pages"
): string => {
  const directory = mkdtempSync(join(tmpdir(), "jingler-codex-models-"))
  fakeAppServers.push(directory)
  const executable = join(directory, "codex")
  writeFileSync(
    executable,
    `#!/usr/bin/env node
const pages = ${JSON.stringify(pages)}
const behavior = ${JSON.stringify(behavior)}
let buffer = ""
let initialized = false
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n")
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buffer += chunk
  for (;;) {
    const newline = buffer.indexOf("\\n")
    if (newline < 0) break
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (!line.trim()) continue
    const message = JSON.parse(line)
    if (message.method === "initialize") {
      send({ jsonrpc: "2.0", id: message.id, result: {} })
      continue
    }
    if (message.method === "initialized") {
      initialized = true
      continue
    }
    if (message.method !== "model/list") continue
    if (!initialized) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32002, message: "not initialized" }
      })
      continue
    }
    if (behavior === "exit") process.exit(0)
    if (behavior === "hang") continue
    const cursor = message.params && message.params.cursor
    if (behavior === "endless") {
      const next = String(Number(cursor ?? "-1") + 1)
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { data: [{ id: "model-" + next }], nextCursor: next }
      })
      continue
    }
    const key = typeof cursor === "string" ? cursor : "__first__"
    send({ jsonrpc: "2.0", id: message.id, result: pages[key] })
  }
})
`
  )
  chmodSync(executable, 0o755)
  return executable
}

afterEach(() => {
  for (const directory of fakeAppServers.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe("toModelOptions", () => {
  it("labels each model with its display name", () => {
    expect(toModelOptions([model({ id: "gpt-5.6-sol", displayName: "GPT-5.6-Sol" })])).toStrictEqual([
      { id: "gpt-5.6-sol", label: "GPT-5.6-Sol" }
    ])
  })

  it("falls back to the id when a display name is absent", () => {
    expect(toModelOptions([model({ id: "gpt-5.5" })])).toStrictEqual([{ id: "gpt-5.5", label: "gpt-5.5" }])
  })

  // Callers (defaultModel, the composer's fallback) treat index 0 as the
  // default, so the CLI's own default has to lead — regardless of list order.
  it("puts the harness's default model first", () => {
    const options = toModelOptions([
      model({ id: "gpt-5.4" }),
      model({ id: "gpt-5.6-sol", isDefault: true }),
      model({ id: "gpt-5.5" })
    ])
    expect(options[0]!.id).toBe("gpt-5.6-sol")
  })

  it("preserves the server's order among non-default models", () => {
    const options = toModelOptions([
      model({ id: "gpt-5.6-sol", isDefault: true }),
      model({ id: "gpt-5.6-terra" }),
      model({ id: "gpt-5.6-luna" })
    ])
    expect(options.map((o) => o.id)).toStrictEqual(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"])
  })

  // `codex-auto-review` ships hidden — it's an internal harness model, not
  // something to offer in the picker.
  it("drops hidden models", () => {
    const options = toModelOptions([
      model({ id: "gpt-5.6-sol", isDefault: true }),
      model({ id: "codex-auto-review", hidden: true })
    ])
    expect(options.map((o) => o.id)).toStrictEqual(["gpt-5.6-sol"])
  })

  it("deduplicates model ids after preferring visible defaults", () => {
    const options = toModelOptions([
      model({ id: "gpt-5.6-sol", hidden: true }),
      model({ id: "gpt-5.5" }),
      model({ id: "gpt-5.6-sol", displayName: "GPT-5.6-Sol", isDefault: true }),
      model({ id: "gpt-5.5", displayName: "Duplicate" })
    ])
    expect(options).toStrictEqual([
      { id: "gpt-5.6-sol", label: "GPT-5.6-Sol" },
      { id: "gpt-5.5", label: "gpt-5.5" }
    ])
  })

  it("returns nothing for an empty catalogue", () => {
    expect(toModelOptions([])).toStrictEqual([])
  })
})

describe("fetchCodexModels", () => {
  it("sends initialized before model/list", async () => {
    const executable = fakeModelServer({
      __first__: {
        data: [{ id: "gpt-5.6-sol", isDefault: true }]
      }
    })

    await expect(fetchCodexModels(executable)).resolves.toStrictEqual([
      { id: "gpt-5.6-sol", label: "gpt-5.6-sol" }
    ])
  })

  it("returns models from every page in server order with the default first", async () => {
    const executable = fakeModelServer({
      __first__: {
        data: [
          { id: "gpt-5.5", displayName: "GPT-5.5" },
          { id: "codex-auto-review", hidden: true }
        ],
        nextCursor: "page-2"
      },
      "page-2": {
        data: [
          { id: "gpt-5.6-sol", displayName: "GPT-5.6-Sol", isDefault: true },
          { id: "gpt-5.5", displayName: "Duplicate" }
        ],
        nextCursor: "page-3"
      },
      "page-3": {
        data: [{ id: "gpt-5.4" }],
        nextCursor: null
      }
    })

    await expect(fetchCodexModels(executable)).resolves.toStrictEqual([
      { id: "gpt-5.6-sol", label: "GPT-5.6-Sol" },
      { id: "gpt-5.5", label: "GPT-5.5" },
      { id: "gpt-5.4", label: "gpt-5.4" }
    ])
  })

  it.each([
    ["missing data", {}],
    ["non-array data", { data: "models" }],
    ["malformed model", { data: [{ id: 42 }] }],
    ["malformed cursor", { data: [{ id: "gpt-5.6-sol" }], nextCursor: 42 }]
  ])("resolves null for a malformed page: %s", async (_name, page) => {
    const executable = fakeModelServer({ __first__: page })
    await expect(fetchCodexModels(executable)).resolves.toBeNull()
  })

  it("resolves null when the server repeats a pagination cursor", async () => {
    const executable = fakeModelServer({
      __first__: {
        data: [{ id: "gpt-5.6-sol" }],
        nextCursor: "again"
      },
      again: {
        data: [{ id: "gpt-5.5" }],
        nextCursor: "again"
      }
    })

    await expect(fetchCodexModels(executable)).resolves.toBeNull()
  })

  it("resolves null rather than returning a truncated unbounded catalogue", async () => {
    const executable = fakeModelServer({}, "endless")
    await expect(fetchCodexModels(executable)).resolves.toBeNull()
  })

  it("resolves null when the process exits during model/list", async () => {
    const executable = fakeModelServer({}, "exit")
    await expect(fetchCodexModels(executable)).resolves.toBeNull()
  })

  it("times out without hanging model discovery", async () => {
    const executable = fakeModelServer({}, "hang")
    const started = Date.now()

    await expect(fetchCodexModels(executable, { timeoutMs: 500 })).resolves.toBeNull()
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  // Discovery must never take the app down or hang it: a bogus binary has to
  // resolve null (→ FALLBACK_MODELS) rather than reject.
  it("resolves null when the binary does not exist", async () => {
    await expect(fetchCodexModels("/nonexistent/codex-does-not-exist")).resolves.toBeNull()
  })

  it("resolves null when the binary is not an app-server", async () => {
    await expect(fetchCodexModels("/bin/echo")).resolves.toBeNull()
  })
})
