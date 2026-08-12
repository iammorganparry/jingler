import { CURRENT_RUNTIME_CONTRACTS, type CapabilityProfile } from "@jingler/core"
import {
  authFallback,
  authRouteObserved,
  before,
  event,
  fileChange,
  permission,
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
    id: "resource.cleanup",
    capability: "resources",
    required: [resourceOpened("managed-mcp"), resourceClosed("managed-mcp"), event("Done")],
    forbidden: [],
    ordering: [before(resourceOpened("managed-mcp"), resourceClosed("managed-mcp"))]
  }),
  scenario({
    id: "capability.managed-resources",
    capability: "resources",
    required: [
      toolCall("resource__managed-skill"),
      toolCall("resource__managed-prompt"),
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

export const CORE_CAPABILITY_PROFILE: CapabilityProfile = {
  id: "core",
  required: true,
  scenarioIds: CORE_PI_SCENARIOS.map((scenario) => scenario.id)
}

export const scenarioById = (id: string): EvalScenario | null =>
  CORE_PI_SCENARIOS.find((candidate) => candidate.id === id) ?? null
