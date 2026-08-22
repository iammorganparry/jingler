import { CURRENT_RUNTIME_CONTRACTS, type CapabilityProfile } from "@jingler/core"
import {
  authFallback,
  authRouteObserved,
  before,
  event,
  fileChange,
  permission,
  anyPlanTaskStatus,
  planMarkerDropped,
  planTaskStatus,
  planTaskStatusObserved,
  resourceClosed,
  resourceOpened,
  toolEffect,
  toolCall,
  type EvalScenario
} from "./behavior-contract.js"

const scenario = (
  input: Omit<EvalScenario, "requiredVersions" | "timeoutMs"> & { readonly timeoutMs?: number }
): EvalScenario => ({
  ...input,
  timeoutMs: input.timeoutMs ?? 120_000,
  requiredVersions: CURRENT_RUNTIME_CONTRACTS
})

export const CORE_PI_SCENARIOS: ReadonlyArray<EvalScenario> = [
  scenario({
    id: "lifecycle.complete",
    capability: "core",
    required: [event("Started"), event("Done")],
    forbidden: [],
    ordering: [before(event("Started"), event("Done"))]
  }),
  scenario({
    id: "permission.denied-edit",
    capability: "permissions",
    required: [permission("workspace_edit", "deny"), event("Done")],
    forbidden: [toolEffect("workspace_edit")],
    ordering: []
  }),
  scenario({
    id: "auth.route-pinned",
    capability: "authentication",
    required: [authRouteObserved(), event("Done")],
    forbidden: [authFallback()],
    ordering: []
  }),
  scenario({
    id: "diff.create-edit-delete-rename",
    capability: "file-changes",
    required: [
      fileChange("A", "src/new.ts"),
      fileChange("M", "src/edit.ts"),
      fileChange("D", "src/delete.ts"),
      fileChange("R", "src/renamed.ts"),
      event("Done")
    ],
    forbidden: [],
    ordering: []
  }),
  scenario({
    id: "capability.managed-resources",
    capability: "resources",
    required: [
      toolCall("jingler_list_resources"),
      toolCall("jingler_load_resource"),
      toolCall("mcp__managed__write_file"),
      fileChange("A", "src/mcp-created.ts"),
      resourceOpened("managed-mcp"),
      resourceClosed("managed-mcp"),
      event("Done")
    ],
    forbidden: [],
    ordering: [before(resourceOpened("managed-mcp"), resourceClosed("managed-mcp"))]
  }),
  scenario({
    id: "structured.question-plan",
    capability: "structured-interaction",
    required: [event("QuestionRequested"), event("PlanProposed"), event("Done")],
    forbidden: [],
    ordering: [before(event("QuestionRequested"), event("PlanProposed"))]
  }),
  scenario({
    id: "remote.contract-compatible",
    capability: "remote",
    required: [event("RemoteContractAccepted"), event("Done")],
    forbidden: [],
    ordering: []
  })
]

/**
 * Scenarios that must run through the FULL harness (`runHarnessScenario`),
 * because the behavior under test is `AgentRunner`'s own fold — plan
 * checkpoint markers parsed out of assistant text and persisted to the
 * canonical plan. Kept out of `CORE_PI_SCENARIOS` so model certification
 * (which drives `runPiScenario`) does not try to execute them below the
 * harness, where the fold never happens and they would fail vacuously.
 */
export const HARNESS_PI_SCENARIOS: ReadonlyArray<EvalScenario> = [
  // The reported regression: the agent works the plan, the panel never moves.
  // Passing means the PERSISTED plan shows both tasks completed after a turn
  // whose text carried valid checkpoint markers.
  scenario({
    id: "plan.task-status-persists",
    capability: "plan-execution",
    required: [
      planTaskStatus("01", "01.a", "completed"),
      planTaskStatus("01", "01.b", "completed"),
      event("Done")
    ],
    forbidden: [planMarkerDropped()],
    ordering: []
  }),
  // A marker naming ids outside the canonical plan is dropped loudly (warning
  // + corrective steer), and valid markers in the same turn still persist.
  scenario({
    id: "plan.task-status-unknown-id-dropped",
    capability: "plan-execution",
    required: [
      planMarkerDropped("unknown stage 99"),
      planTaskStatus("01", "01.a", "completed"),
      event("Done")
    ],
    forbidden: [planTaskStatusObserved("99", "99.z")],
    ordering: []
  }),
  // Stage + task ids are the identity: a stale fingerprint warns but applies.
  scenario({
    id: "plan.task-status-fingerprint-drift",
    capability: "plan-execution",
    required: [planTaskStatus("01", "01.a", "completed"), event("Done")],
    forbidden: [planMarkerDropped()],
    ordering: []
  })
]

/**
 * Tool-selection and memory-workflow scenarios, defined once and run twice:
 * scripted through the deterministic runtime (plumbing — multi-server MCP
 * mounts, the workflow-status polling contract) and sampled pass@k against
 * real models under the live matrix (behavior — does the model pick the right
 * MCP tool, propose a memory when the task calls for it, and poll the
 * workflow to a terminal state).
 */
export const SELECTION_PI_SCENARIOS: ReadonlyArray<EvalScenario> = [
  scenario({
    id: "memory.propose-on-gotcha",
    capability: "memory",
    required: [
      toolCall("mcp__jingler-memory__memory_propose"),
      toolEffect("mcp__jingler-memory__memory_propose"),
      toolCall("mcp__jingler-memory__memory_workflow_status"),
      event("Done")
    ],
    forbidden: [toolEffect("mcp__scratch__write_file")],
    ordering: [
      before(
        toolCall("mcp__jingler-memory__memory_propose"),
        toolCall("mcp__jingler-memory__memory_workflow_status")
      )
    ],
    timeoutMs: 300_000
  }),
  scenario({
    id: "mcp.select-correct-tool",
    capability: "selection",
    required: [
      toolCall("mcp__jingler-memory__memory_propose"),
      event("Done")
    ],
    forbidden: [
      toolCall("mcp__scratch__write_file"),
      toolEffect("mcp__scratch__write_file")
    ],
    ordering: [],
    timeoutMs: 300_000
  })
]

/**
 * The live half of the plan-progress regression guard: a REAL model is handed
 * an executing plan (with exact checkpoint ids in its execution note) and must
 * emit the markers unprompted — the prompt-compliance failure that actually
 * shipped. Run only under the manual live matrix with pass@k sampling;
 * single-shot live model behavior WILL flake, so the verifier runs each
 * sample through this scenario and passes on majority.
 */
export const LIVE_HARNESS_PI_SCENARIOS: ReadonlyArray<EvalScenario> = [
  scenario({
    id: "plan.task-status-live",
    capability: "plan-execution",
    required: [
      planTaskStatus("01", "01.a", "completed"),
      planTaskStatus("01", "01.b", "completed"),
      event("Done")
    ],
    forbidden: [planMarkerDropped()],
    ordering: [],
    timeoutMs: 300_000
  })
]

/**
 * Scenarios scored only against replayed traces (recorded sessions converted
 * via `transcript-to-trace`). Deliberately id-agnostic: a real session's plan
 * has its own stage/task ids, so the signal is "did ANY task ever reach
 * completed", which is exactly what the plan panel shows the operator.
 */
export const REPLAY_PI_SCENARIOS: ReadonlyArray<EvalScenario> = [
  scenario({
    id: "plan.task-status-replay",
    capability: "plan-execution",
    required: [anyPlanTaskStatus("completed"), event("Done")],
    forbidden: [],
    ordering: []
  })
]

export const CORE_CAPABILITY_PROFILE: CapabilityProfile = {
  id: "core",
  required: true,
  scenarioIds: CORE_PI_SCENARIOS.map((scenario) => scenario.id)
}

export const scenarioById = (id: string): EvalScenario | null =>
  CORE_PI_SCENARIOS.find((candidate) => candidate.id === id) ??
  HARNESS_PI_SCENARIOS.find((candidate) => candidate.id === id) ??
  SELECTION_PI_SCENARIOS.find((candidate) => candidate.id === id) ??
  LIVE_HARNESS_PI_SCENARIOS.find((candidate) => candidate.id === id) ??
  REPLAY_PI_SCENARIOS.find((candidate) => candidate.id === id) ??
  null
