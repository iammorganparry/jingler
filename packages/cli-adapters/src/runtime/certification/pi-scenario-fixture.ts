import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseStep
} from "@earendil-works/pi-ai"
import { defaultPlan } from "@jingler/core"

/** Scripted model responses shared by deterministic and Electron certification. */
export const scriptedPiScenarioResponses = (
  scenarioId: string
): ReadonlyArray<FauxResponseStep> => {
  if (scenarioId === "permission.denied-edit" || scenarioId === "diff.create-edit-delete-rename") {
    return [
      fauxAssistantMessage(fauxToolCall("workspace_edit", { path: "src/edit.ts" }), {
        stopReason: "toolUse"
      }),
      fauxAssistantMessage("complete")
    ]
  }
  if (scenarioId === "resource.cleanup") {
    return [
      fauxAssistantMessage(fauxToolCall("managed-mcp", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("complete")
    ]
  }
  if (scenarioId === "capability.managed-resources") {
    return [
      fauxAssistantMessage(fauxToolCall("resource__managed-skill", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("resource__managed-prompt", {}), { stopReason: "toolUse" }),
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
