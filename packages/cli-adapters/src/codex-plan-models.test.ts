import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type PlanPrdStage,
  resolveWorkerRoutingConfig,
  workerRoutingMismatch,
  type WorkerRoutingConfig
} from "@jingler/core"
import { describe, expect, it } from "vitest"
import {
  planningOrchestrationRoutes,
  unavailableOrchestrationAssignment
} from "./agent-runner.js"
import { fetchCodexModels } from "./codex-models.js"
import { planNote } from "./plan-prompt.js"

const LATER_PAGE_MODEL = "gpt-5.6-terra"

const assignedStage: PlanPrdStage = {
  id: "01",
  title: "Ship",
  intent: "Ship the change.",
  markdown: "<p>Ship the change.</p><ul data-files></ul>",
  acceptance: [],
  complexity: "low",
  dependencies: [],
  assignment: {
    agentId: "worker-ship",
    cli: "codex",
    model: LATER_PAGE_MODEL,
    reason: "Configured worker route."
  },
  executionStatus: "queued"
}

const fakePaginatedCodex = (): { readonly executable: string; readonly cleanup: () => void } => {
  const directory = mkdtempSync(join(tmpdir(), "jingler-codex-plan-models-"))
  const executable = join(directory, "codex")
  writeFileSync(
    executable,
    `#!/usr/bin/env node
let buffer = ""
let initialized = false
const send = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n")
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
      send({ id: message.id, result: {} })
      continue
    }
    if (message.method === "initialized") {
      initialized = true
      continue
    }
    if (message.method !== "model/list") continue
    if (!initialized) {
      send({ id: message.id, error: { code: -32002, message: "not initialized" } })
      continue
    }
    if (message.params && message.params.cursor === "page-2") {
      send({
        id: message.id,
        result: {
          data: [{ id: "${LATER_PAGE_MODEL}", displayName: "GPT-5.6 Terra" }],
          nextCursor: null
        }
      })
      continue
    }
    send({
      id: message.id,
      result: {
        data: [{ id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", isDefault: true }],
        nextCursor: "page-2"
      }
    })
  }
})
`
  )
  chmodSync(executable, 0o755)
  return {
    executable,
    cleanup: () => rmSync(directory, { recursive: true, force: true })
  }
}

describe("Codex plan model catalogue", () => {
  it("selects a configured worker model without asking the planner to route it", async () => {
    const fake = fakePaginatedCodex()
    try {
      const models = await fetchCodexModels(fake.executable)
      expect(models?.map((model) => model.id)).toEqual([
        "gpt-5.6-sol",
        LATER_PAGE_MODEL
      ])
      if (models === null) return

      const routes = planningOrchestrationRoutes([
        { cli: "codex", models }
      ])
      const configured: WorkerRoutingConfig = {
        default: { cli: "codex", model: "gpt-5.6-sol" },
        low: { cli: "codex", model: LATER_PAGE_MODEL },
        medium: { cli: "codex", model: "gpt-5.6-sol" },
        high: { cli: "codex", model: "gpt-5.6-sol" }
      }
      const routing = resolveWorkerRoutingConfig(configured, routes)

      expect(routing?.low).toEqual({
        cli: "codex",
        model: LATER_PAGE_MODEL
      })
      expect(
        unavailableOrchestrationAssignment([assignedStage], routes)
      ).toBeNull()
      expect(
        workerRoutingMismatch(
          [assignedStage],
          routing ?? configured
        )
      ).toBeNull()
      const plannerPrompt = planNote(
        "codex",
        undefined,
        routes,
        routing ?? undefined
      )
      expect(plannerPrompt).not.toContain(`codex/${LATER_PAGE_MODEL}`)
      expect(plannerPrompt).toContain("Do NOT add data-assignment")
    } finally {
      fake.cleanup()
    }
  })
})
