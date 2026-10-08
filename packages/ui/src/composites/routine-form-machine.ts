import type { ProjectRoutineTemplate, ProviderCatalog, Routine, RoutineInput, ReasoningSetting } from "@jingler/core"
import { piEndpointId } from "@jingler/core"
import { assign, setup } from "xstate"
export type RoutineModel = ProviderCatalog["connections"][number]["models"][number] & {
  connection: ProviderCatalog["connections"][number]["connection"]
}
export const localDateTime = (time: number) => {
  const date = new Date(time)
  return new Date(time - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19)
}
export const modelKey = (model: RoutineModel) => `${model.connection.id}/${model.providerId}/${model.id}`
export interface RoutineDraft {
  name: string
  branch: string
  model: string
  reasoning: string
  prompt: string
  schedule: string
  at: string
  interval: string
  duration: string
  enabled: boolean
}
interface Context {
  draft: RoutineDraft
  approved: boolean
  error: string | null
}
type Event =
  | { type: "RESET"; draft: RoutineDraft }
  | { type: "EDIT"; patch: Partial<RoutineDraft> }
  | { type: "APPROVE"; approved: boolean }
  | { type: "ERROR"; message: string }
interface Input {
  template?: ProjectRoutineTemplate
  selected?: Routine
  models: RoutineModel[]
}
const draftReasoning = (reasoning: Routine["reasoning"] | undefined): string => {
  if (!reasoning) return "default"
  return reasoning.enabled ? (reasoning.effort ?? "on") : "off"
}
const localRoutineDraft = ({ selected, models }: Input): RoutineDraft => ({
  name: selected?.name ?? "",
  branch: selected?.baseBranch ?? "main",
  model: selected
    ? `${selected.connectionId}/${selected.providerId}/${selected.modelId}`
    : models[0]
      ? modelKey(models[0])
      : "",
  reasoning: draftReasoning(selected?.reasoning),
  prompt: selected?.prompt ?? "",
  schedule: selected?.schedule.kind ?? "once",
  at: localDateTime(selected?.schedule.at ?? Date.now() + 60000),
  interval: selected?.schedule.kind === "interval" ? String(selected.schedule.everyMs / 60000) : "60",
  duration: String(selected ? selected.maxDurationMs / 60000 : 10),
  enabled: selected?.enabled ?? false,
})
export const routineDraft = (input: Input): RoutineDraft => input.template ? templateDraft(input.template, input.models) : localRoutineDraft(input)
export const templateDraft = (template: ProjectRoutineTemplate, models: RoutineModel[]): RoutineDraft => {
  const matches = template.providerId && template.modelId
    ? models.filter((model) => model.connection.targetId === "desktop" && model.selectable && model.providerId === template.providerId && model.id === template.modelId) : []
  return {
    name: template.name, branch: template.baseBranch, prompt: template.prompt,
    model: matches.length === 1 ? modelKey(matches[0]!) : "",
    reasoning: draftReasoning(template.reasoning), schedule: template.schedule.kind,
    at: localDateTime(template.schedule.at),
    interval: template.schedule.kind === "interval" ? String(template.schedule.everyMs / 60000) : "60",
    duration: String(template.maxDurationMs / 60000), enabled: false,
  }
}
export const routineFormMachine = setup({
  types: {
    context: {} as Context,
    events: {} as Event,
    input: {} as Input,
  },
}).createMachine({
  context: ({ input }) => ({ draft: routineDraft(input), approved: false, error: null }),
  on: {
    RESET: { actions: assign({ draft: ({ event }) => event.draft, approved: false, error: null }) },
    EDIT: {
      actions: assign(({ context, event }) => {
        const draft = { ...context.draft, ...event.patch }
        return JSON.stringify(draft) === JSON.stringify(context.draft)
          ? {}
          : { draft, approved: false, error: null }
      }),
    },
    APPROVE: { actions: assign({ approved: ({ event }) => event.approved, error: null }) },
    ERROR: { actions: assign({ error: ({ event }) => event.message }) },
  },
})
const reasoningSetting = (value: string): ReasoningSetting | null => {
  if (value === "default") return null
  if (value === "on") return { enabled: true }
  if (value === "off") return { enabled: false }
  if (
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  )
    return { enabled: true, effort: value }
  throw new Error("Choose a supported reasoning setting.")
}
export function routinePayload(
  draft: RoutineDraft,
  approved: boolean,
  projectId: string,
  models: RoutineModel[],
  selected?: Routine,
  template?: ProjectRoutineTemplate,
): RoutineInput {
  if (!approved) throw new Error("Approve these exact settings before saving or running.")
  if (!projectId || (selected && selected.projectId !== projectId))
    throw new Error("Choose the routine's local project.")
  const model = models.find((item) => modelKey(item) === draft.model)
  if (!model)
    throw new Error("The saved model is unavailable. Choose an available managed Pi model and approve again.")
  validateRoutineDraft(draft)
  const source = selected ?? template
  const at =
    source && draft.at === localDateTime(source.schedule.at)
      ? source.schedule.at
      : new Date(draft.at).getTime()
  const duration = Math.round(Number(draft.duration) * 60000)
  const interval = Math.round(Number(draft.interval) * 60000)
  return {
    name: draft.name.trim(),
    prompt: draft.prompt,
    projectId,
    baseBranch: draft.branch.trim(),
    runtimeId: "pi",
    endpointId: piEndpointId(model.connection.targetId, model.connection.id),
    connectionId: model.connection.id,
    providerId: model.providerId,
    modelId: model.id,
    reasoning: source && draft.reasoning === draftReasoning(source.reasoning) ? source.reasoning : reasoningSetting(draft.reasoning),
    mode: "ask",
    schedule:
      draft.schedule === "interval" ? { kind: "interval", at, everyMs: interval } : { kind: "once", at },
    enabled: draft.enabled,
    approved: true,
    maxDurationMs: duration,
  }
}

function validateRoutineDraft(draft: RoutineDraft) {
  if (
    !draft.name.trim() ||
    draft.name.trim().length > 120 ||
    !draft.prompt.trim() ||
    draft.prompt.length > 100000 ||
    !draft.branch.trim() ||
    draft.branch.trim().length > 256
  )
    throw new Error("Provide a name, prompt and base branch within their allowed lengths.")
  const at = new Date(draft.at).getTime()
  if (!Number.isSafeInteger(at) || at < 0) throw new Error("Choose a valid first occurrence.")
  const duration = Math.round(Number(draft.duration) * 60000)
  if (!Number.isInteger(duration) || duration < 1000 || duration > 86400000)
    throw new Error("Maximum duration must be from 1 second to 1440 minutes.")
  const interval = Math.round(Number(draft.interval) * 60000)
  if (draft.schedule !== "once" && draft.schedule !== "interval")
    throw new Error("Choose a supported schedule.")
  if (
    draft.schedule === "interval" &&
    (!Number.isInteger(interval) || interval < 1000 || interval > 365 * 86400000)
  )
    throw new Error("Interval must be from 1 second to 525600 minutes.")
}
