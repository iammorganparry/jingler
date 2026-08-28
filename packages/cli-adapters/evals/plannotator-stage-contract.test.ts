import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const read = (path: string) => readFileSync(join(root, path), "utf8")

const stages = ["host", "mode", "projection", "embed", "cleanup"] as const

describe("Plannotator migration stage contracts", () => {
  it("covers every approved migration stage in order", () => {
    expect(stages).toEqual(["host", "mode", "projection", "embed", "cleanup"])
  })

  it("host: pins and contains the exact extension version", () => {
    const packageJson = JSON.parse(read("packages/cli-adapters/package.json")) as {
      dependencies: Record<string, string>
    }
    expect(packageJson.dependencies["@plannotator/pi-extension"]).toBe("0.27.8")
    const desktopPackage = JSON.parse(read("apps/desktop/package.json")) as {
      dependencies: Record<string, string>
    }
    expect(desktopPackage.dependencies["@plannotator/pi-extension"]).toBe("0.27.8")
    expect(read("packages/cli-adapters/src/runtime/agent/locked-pi-resources.ts"))
      .toContain("PLANNOTATOR_EXTENSION_PATH")
    expect(read("packages/cli-adapters/src/runtime/agent/pi-session-factory.ts"))
      .toContain('mode: "rpc"')
  })

  it("mode: leaves plan authority and automatic execution with Plannotator", () => {
    const tools = read("packages/cli-adapters/src/runtime/agent/pi-jingler-tools.ts")
    expect(tools).not.toMatch(/jingler_(?:save_draft|discard|submit)_plan/u)
    const factory = read("packages/cli-adapters/src/runtime/agent/pi-session-factory.ts")
    expect(factory).toContain('action: "plan-mode"')
    expect(read("packages/cli-adapters/src/runtime/agent/locked-pi-resources.ts"))
      .toContain('executionMode: "automatic"')
    expect(factory).toContain("plannotator_submit_plan")
  })

  it("projection: keeps host state live-only and converts it through the compatibility DTO", () => {
    const conversation = read("packages/core/src/conversation.ts")
    expect(conversation).toContain("PlannotatorStateChanged")
    expect(conversation).toContain("Live-only disposable projection")
    const projection = read("packages/core/src/plannotator-projection.ts")
    expect(projection).toContain("plannotatorProjectionToPlanDocument")
    expect(projection).toContain("Compatibility DTO")
  })

  it("embed: requires a sandboxed loopback-only view with no Node or preload", () => {
    const preview = read("apps/desktop/src/main/preview-view.ts")
    expect(preview).toContain("sandbox: true")
    expect(preview).toContain("contextIsolation: true")
    expect(preview).toContain("nodeIntegration: false")
    expect(preview).not.toMatch(/preload\s*:/u)
    expect(preview).toContain("isSameOriginHttpUrl")
    expect(preview).toContain('setWindowOpenHandler(() => ({ action: "deny" }))')
  })

  it("cleanup: old plan persistence, mutation, checkpoint, and RPC engines cannot return", () => {
    for (const path of [
      "packages/cli-adapters/src/plan-store.ts",
      "packages/cli-adapters/src/plan-mutations.ts",
      "packages/cli-adapters/src/plan-task-progress.ts",
      "apps/desktop/src/renderer/plan-document-machine.ts",
      "apps/desktop/src/renderer/plan-document-registry.ts"
    ]) {
      expect(existsSync(join(root, path)), path).toBe(false)
    }
    const contracts = read("packages/contracts/src/index.ts")
    expect(contracts).not.toMatch(/Rpc\.make\("Plan\./u)
    expect(contracts).not.toMatch(/Agent\.(?:approvePlan|revisePlan|resumePlan|commentPlanStep)/u)
  })
})
