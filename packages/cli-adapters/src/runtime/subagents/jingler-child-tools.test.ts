import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

const roots: string[] = []
const originalCapability = process.env.JINGLER_SUBAGENT_CAPABILITY
afterEach(async () => {
  if (originalCapability === undefined) delete process.env.JINGLER_SUBAGENT_CAPABILITY
  else process.env.JINGLER_SUBAGENT_CAPABILITY = originalCapability
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ))
})

const extensionPath = new URL(
  "../../../runtime-assets/jingler-child-tools.mjs",
  import.meta.url
)

describe("Jingler child tools extension", () => {
  it("activates every brokered capability without removing supervisor tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-child-tools-"))
    roots.push(root)
    const capabilityPath = join(root, "capability.json")
    await writeFile(capabilityPath, JSON.stringify({
      version: 1,
      endpoint: "http://127.0.0.1:1/v1/subagent-tool",
      token: "token",
      parentPiSessionId: "parent",
      tools: [
        {
          id: "workspace_read_file",
          description: "Read one file",
          inputSchema: { type: "object", properties: {} }
        },
        {
          id: "workspace_list_files",
          description: "List files",
          inputSchema: { type: "object", properties: {} }
        }
      ]
    }))
    process.env.JINGLER_SUBAGENT_CAPABILITY = capabilityPath
    const registered: string[] = []
    const setActiveTools = vi.fn()
    let sessionStart: (() => void) | undefined
    const module = await import(
      `${extensionPath.href}?test=${crypto.randomUUID()}`
    ) as { default: (pi: {
      registerTool: (tool: { readonly name: string }) => void
      on: (event: "session_start", handler: () => void) => void
      getActiveTools: () => string[]
      setActiveTools: (tools: string[]) => void
    }) => void }

    module.default({
      registerTool: (tool) => registered.push(tool.name),
      on: (_event, handler) => {
        sessionStart = handler
      },
      getActiveTools: () => ["contact_supervisor"],
      setActiveTools
    })
    sessionStart?.()

    expect(registered).toEqual(["workspace_read_file", "workspace_list_files"])
    expect(setActiveTools).toHaveBeenCalledWith([
      "contact_supervisor",
      "workspace_read_file",
      "workspace_list_files"
    ])
  })
})
