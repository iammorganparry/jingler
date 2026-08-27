import { CURRENT_RUNTIME_CONTRACTS, type CapabilityProfile } from "@jingler/core"
import {
  authFallback,
  authRouteObserved,
  before,
  event,
  fileChange,
  fileContentContains,
  permission,
  reportContains,
  resourceClosed,
  resourceOpened,
  toolEffect,
  toolCall,
  toolOutputContains,
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
    id: "quality.semantic-references",
    capability: "code-intelligence",
    required: [
      toolCall("code_intelligence"),
      toolOutputContains("code_intelligence", "source.ts"),
      toolOutputContains("code_intelligence", "reexport.ts"),
      event("Done")
    ],
    forbidden: [toolOutputContains("code_intelligence", "\"path\":\"use.ts\",\"line\":2")],
    ordering: []
  }),
  scenario({
    id: "quality.structural-preview",
    capability: "code-intelligence",
    required: [toolCall("structural_search"), toolOutputContains("structural_search", "\"matchCount\":1"), event("Done")],
    forbidden: [toolCall("structural_edit")],
    ordering: []
  }),
  scenario({
    id: "quality.semantic-rename",
    capability: "code-intelligence",
    required: [
      toolCall("code_intelligence"),
      permission("code_rename", "allow"),
      toolCall("code_rename"),
      fileChange("M", "source.ts"),
      fileContentContains("source.ts", "const credential = 1"),
      fileContentContains("reexport.ts", "credential as publicToken"),
      fileContentContains("use.ts", "const token = 2"),
      event("Done")
    ],
    forbidden: [toolCall("structural_edit"), fileContentContains("use.ts", "const credential = 2")],
    ordering: [before(toolCall("code_intelligence"), toolCall("code_rename"))]
  }),
  scenario({
    id: "quality.plain-text-skip",
    capability: "code-intelligence",
    required: [reportContains("plain text"), event("Done")],
    forbidden: [toolCall("code_intelligence"), toolCall("structural_search"), toolCall("code_rename"), toolCall("structural_edit")],
    ordering: []
  }),
  scenario({
    id: "remote.contract-compatible",
    capability: "remote",
    required: [event("RemoteContractAccepted"), event("Done")],
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
  CORE_PI_SCENARIOS.find((candidate) => candidate.id === id) ?? null
