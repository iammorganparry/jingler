import { CURRENT_RUNTIME_CONTRACTS } from "@jingler/core"
import {
  authFallback,
  authRoute,
  before,
  event,
  fileChange,
  permission,
  resourceClosed,
  resourceOpened,
  toolEffect,
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
    required: [permission("workspace.edit", "deny"), event("Done")],
    forbidden: [toolEffect("workspace.edit")],
    ordering: []
  }),
  scenario({
    id: "auth.codex-subscription-pinned",
    capability: "authentication",
    required: [authRoute("openai-codex-oauth"), event("Done")],
    forbidden: [authFallback()],
    ordering: []
  }),
  scenario({
    id: "auth.claude-subscription-pinned",
    capability: "authentication",
    required: [authRoute("claude-setup-token"), event("Done")],
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

export const scenarioById = (id: string): EvalScenario | null =>
  CORE_PI_SCENARIOS.find((candidate) => candidate.id === id) ?? null
