import { readFile, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SubagentFleetNode } from "@jingler/core"

interface DurableStep {
  readonly agent?: string
  readonly label?: string
  readonly workflowKey?: string
  readonly status?: string
  readonly startedAt?: number
  readonly sessionFile?: string
  readonly model?: string
  readonly runId?: string
  readonly toolCount?: number
}

interface DurableStatus {
  readonly runId?: string
  readonly sessionId?: string
  readonly state?: string
  readonly mode?: string
  readonly startedAt?: number
  readonly lastUpdate?: number
  readonly steps?: ReadonlyArray<DurableStep>
}

const activeState = (state: string | undefined): boolean =>
  state === "queued" || state === "running" || state === "paused"

const nodeStatus = (
  state: string | undefined
): SubagentFleetNode["status"] => {
  switch (state) {
    case "queued": return "queued"
    case "paused": return "paused"
    case "completed": return "completed"
    case "failed": return "failed"
    case "stopped": return "stopped"
    default: return "running"
  }
}

const usage = (startedAt: number, updatedAt: number, toolCalls = 0) => ({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  costUsd: 0,
  durationMs: Math.max(0, updatedAt - startedAt),
  toolCalls
})

const tempScopeId = (): string =>
  typeof process.getuid === "function"
    ? `uid-${process.getuid()}`
    : `user-${process.env.USER ?? process.env.USERNAME ?? "unknown"}`

export const defaultPiSubagentAsyncDir = (): string =>
  join(tmpdir(), `pi-subagents-${tempScopeId()}`, "async-subagent-runs")

export const readDurablePiSubagentNodes = async (input: {
  readonly asyncDir?: string
  readonly parentPiSessionId: string
  readonly parentPiSessionAliases: ReadonlySet<string>
  readonly now?: number
}): Promise<ReadonlyArray<SubagentFleetNode>> => {
  const asyncDir = input.asyncDir ?? defaultPiSubagentAsyncDir()
  let runIds: ReadonlyArray<string>
  try {
    runIds = await readdir(join(asyncDir, ".active-runs"))
  } catch {
    return []
  }
  const statuses = await Promise.all(runIds.slice(0, 32).map(async (runId) => {
    try {
      return JSON.parse(
        await readFile(join(asyncDir, runId, "status.json"), "utf8")
      ) as DurableStatus
    } catch {
      return null
    }
  }))
  return statuses.flatMap((status) => {
    if (
      status === null ||
      !activeState(status.state) ||
      typeof status.runId !== "string" ||
      typeof status.startedAt !== "number" ||
      typeof status.sessionId !== "string" ||
      !input.parentPiSessionAliases.has(status.sessionId)
    ) return []
    const updatedAt = status.lastUpdate ?? input.now ?? Date.now()
    const rootId = `${input.parentPiSessionId}/active/${status.runId}`
    const steps = status.steps ?? []
    const root: SubagentFleetNode = {
      id: rootId,
      runId: status.runId,
      parentId: null,
      parentPiSessionId: input.parentPiSessionId,
      agent: steps[0]?.agent ?? status.mode ?? "subagent",
      task: "Active delegated work",
      model: null,
      status: nodeStatus(status.state),
      background: true,
      sessionFile: null,
      currentTool: null,
      startedAt: status.startedAt,
      updatedAt,
      completedAt: null,
      usage: usage(status.startedAt, updatedAt),
      artifacts: [],
      attention: null
    }
    return [
      root,
      ...steps.map((step, index): SubagentFleetNode => {
        const startedAt = step.startedAt ?? status.startedAt!
        return {
          id: `${rootId}/${encodeURIComponent(step.workflowKey ?? String(index))}`,
          runId: step.runId ?? `${status.runId}:step:${index}`,
          parentId: rootId,
          parentPiSessionId: input.parentPiSessionId,
          agent: step.agent ?? step.label ?? `step-${index + 1}`,
          task: step.label ?? "Delegated work",
          model: step.model ?? null,
          status: nodeStatus(step.status),
          background: true,
          sessionFile: step.sessionFile ?? null,
          currentTool: null,
          startedAt,
          updatedAt,
          completedAt: null,
          usage: usage(startedAt, updatedAt, step.toolCount ?? 0),
          artifacts: [],
          attention: null
        }
      })
    ]
  })
}
