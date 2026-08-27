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
  if (scenarioId === "capability.managed-resources") {
    return [
      fauxAssistantMessage(fauxToolCall("jingler_list_resources", { query: "managed" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("jingler_load_resource", { id: "managed-skill" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("jingler_load_resource", { id: "managed-prompt" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("mcp__managed__write_file", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("complete")
    ]
  }
  if (scenarioId === "quality.semantic-references") {
    return [
      fauxAssistantMessage(fauxToolCall("code_intelligence", { action: "references", file: "source.ts", symbol: "token", line: 1 }), { stopReason: "toolUse" }),
      fauxAssistantMessage("source.ts and reexport.ts contain the semantic references; the shadowed use.ts:2 local is excluded.")
    ]
  }
  if (scenarioId === "quality.structural-preview") {
    return [
      fauxAssistantMessage(fauxToolCall("structural_search", { symbol: "run", kind: "call" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Found one direct call.")
    ]
  }
  if (scenarioId === "quality.semantic-rename") {
    return [
      fauxAssistantMessage(fauxToolCall("code_intelligence", { action: "references", file: "source.ts", symbol: "token", line: 1 }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("code_rename", { file: "source.ts", symbol: "token", line: 1, newName: "credential" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Renamed the semantic symbol.")
    ]
  }
  if (scenarioId === "quality.plain-text-skip") {
    return [fauxAssistantMessage("plain text")]
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
