import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseStep
} from "@earendil-works/pi-ai"
import {
  defaultPlan,
  renderPlanTaskProgressMarker,
  type PlanPrd
} from "@jingler/core"
import { planTaskProgressFingerprint } from "../../plan-task-progress.js"
import type { HarnessScenarioSeedPlan } from "./harness-scenario-runner.js"

export const EVAL_PLAN_ID = "eval-plan"

/** The execution turn all plan scenarios (deterministic and live) start from. */
export const PLAN_EXECUTION_PROMPT =
  "Continue executing the approved plan and checkpoint every task."

/**
 * The canonical plan every harness plan scenario executes against: one stage,
 * two tasks, ids stable so scenario matchers can name them.
 */
export const evalPlanPrd = (): PlanPrd => ({
  title: "PRD: Harness eval plan",
  sections: [],
  stages: [
    {
      id: "01",
      title: "Deliver",
      intent: "Deliver the fixture change.",
      approach: [],
      files: [],
      diagrams: [],
      notes: [],
      tasks: [
        { id: "01.a", text: "Implement the change.", status: "pending" },
        { id: "01.b", text: "Verify the change.", status: "pending" }
      ],
      acceptance: [
        { id: "01.1", text: "The change is verified.", status: "pending", evidence: null }
      ],
      dependencies: []
    }
  ],
  annotations: []
})

export const evalSeedPlan = (): HarnessScenarioSeedPlan => ({
  id: EVAL_PLAN_ID,
  plan: evalPlanPrd(),
  status: "executing"
})

const marker = (
  taskId: string,
  status: "in-progress" | "completed" | "blocked",
  input: { readonly stageId?: string; readonly fingerprint?: string } = {}
): string => {
  const stage = evalPlanPrd().stages[0]!
  return renderPlanTaskProgressMarker({
    stageId: input.stageId ?? stage.id,
    stageFingerprint: input.fingerprint ?? planTaskProgressFingerprint(stage),
    taskId,
    status
  })
}

/** Scripted assistant turns for the full-harness plan scenarios. */
const scriptedHarnessResponses = (
  scenarioId: string
): ReadonlyArray<FauxResponseStep> | null => {
  if (scenarioId === "plan.task-status-persists") {
    return [
      fauxAssistantMessage(
        [
          "Starting the plan.",
          marker("01.a", "in-progress"),
          "Implemented the change.",
          marker("01.a", "completed"),
          marker("01.b", "in-progress"),
          "Verified the change.",
          marker("01.b", "completed"),
          "Plan complete."
        ].join("\n")
      )
    ]
  }
  if (scenarioId === "plan.task-status-unknown-id-dropped") {
    return [
      fauxAssistantMessage(
        [
          "Starting the plan.",
          marker("99.z", "completed", { stageId: "99" }),
          marker("01.a", "completed"),
          "Done."
        ].join("\n")
      )
    ]
  }
  if (scenarioId === "plan.task-status-fingerprint-drift") {
    return [
      fauxAssistantMessage(
        [
          "Starting the plan.",
          marker("01.a", "completed", { fingerprint: "deadbeefdeadbeefdeadbeef" }),
          "Done."
        ].join("\n")
      )
    ]
  }
  return null
}

/** Scripted correct-tool selections for the memory/MCP scenarios. */
const scriptedSelectionResponses = (
  scenarioId: string
): ReadonlyArray<FauxResponseStep> | null => {
  if (scenarioId === "memory.propose-on-gotcha") {
    return [
      fauxAssistantMessage(
        fauxToolCall("mcp__jingler-memory__memory_propose", {
          type: "GOTCHA",
          content: "The fixture build silently fails unless FOO=1 is exported."
        }),
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage(
        fauxToolCall("mcp__jingler-memory__memory_workflow_status", { workflowId: "wf-1" }),
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage(
        fauxToolCall("mcp__jingler-memory__memory_workflow_status", { workflowId: "wf-1" }),
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage("Recorded the gotcha; the memory workflow settled as accepted.")
    ]
  }
  if (scenarioId === "mcp.select-correct-tool") {
    return [
      fauxAssistantMessage(
        fauxToolCall("mcp__jingler-memory__memory_propose", {
          type: "GOTCHA",
          content: "The fixture build silently fails unless FOO=1 is exported."
        }),
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage("Recorded the learning with the memory server.")
    ]
  }
  return null
}

/** Scripted model responses shared by deterministic and Electron certification. */
export const scriptedPiScenarioResponses = (
  scenarioId: string
): ReadonlyArray<FauxResponseStep> => {
  const harness = scriptedHarnessResponses(scenarioId)
  if (harness !== null) return harness
  const selection = scriptedSelectionResponses(scenarioId)
  if (selection !== null) return selection
  if (scenarioId === "permission.denied-edit" || scenarioId === "diff.create-edit-delete-rename") {
    return [
      fauxAssistantMessage(fauxToolCall("workspace_edit", { path: "src/edit.ts" }), {
        stopReason: "toolUse"
      }),
      fauxAssistantMessage("complete")
    ]
  }
  if (scenarioId === "capability.managed-resources") {
    return [
      fauxAssistantMessage(fauxToolCall("jingler_list_resources", { query: "managed" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("jingler_load_resource", { id: "managed-skill" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("jingler_load_resource", { id: "managed-prompt" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("mcp__managed__write_file", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("complete")
    ]
  }
  if (scenarioId === "structured.question-plan") {
    return [
      fauxAssistantMessage(
        fauxToolCall("jingler_ask_question", {
          id: "eval-question",
          questions: [
            {
              question: "Continue?",
              header: "Continue",
              multiSelect: false,
              options: [
                { label: "Yes", description: "Continue the scenario." },
                { label: "No", description: "Stop the scenario." }
              ]
            }
          ]
        }),
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage(
        fauxToolCall("jingler_submit_plan", {
          plan: defaultPlan("Verify deterministic structured interaction.")
        }),
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage("complete")
    ]
  }
  return [fauxAssistantMessage("complete")]
}
