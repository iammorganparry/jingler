import type { ProjectRoutineTemplate, Project, ProviderCatalog } from "@jingler/core"
import { useMachine } from "@xstate/react"
import { RoutinesSettingsView } from "@jingler/ui"
import { rpc } from "./rpc-client.js"
import { routinesMachine } from "./routines-machine.js"
const api = {
  list: rpc.routinesList,
  save: rpc.routinesSave,
  enable: rpc.routinesEnable,
  delete: rpc.routinesDelete,
  runNow: rpc.routinesRunNow,
  cancel: rpc.routinesCancel,
}
export function RoutinesSettings({
  projects,
  templates,
  projectId,
  catalog,
  onSession,
}: {
  templates?: ReadonlyArray<ProjectRoutineTemplate>
  projects: ReadonlyArray<Project>
  projectId: string
  catalog: ProviderCatalog | null
  onSession(id: string): Promise<void>
}) {
  const [state, send] = useMachine(routinesMachine, { input: { api: { ...api, open: onSession } } })
  const { document, editing, error, feedback } = state.context
  const command = state.context.command
  const commandProjectId =
    command.type === "SAVE"
      ? command.input.projectId
      : command.type === "RUN" || command.type === "ENABLE" || command.type === "DELETE"
        ? document.routines.find((routine) => routine.id === command.id)?.projectId
        : undefined
  const visibleError = commandProjectId === undefined || commandProjectId === projectId ? error : null
  const models = (catalog?.connections ?? [])
    .filter((entry) => entry.connection.targetId === "desktop")
    .flatMap((entry) =>
      entry.models
        .filter((model) => model.selectable)
        .map((model) => ({ ...model, connection: entry.connection })),
    )
  return (
    <RoutinesSettingsView
      templates={templates}
      template={state.context.templateProjectId === projectId ? state.context.template : undefined}
      templateLoad={state.context.templateLoad}
      onTemplate={(template) => send({ type: "TEMPLATE", projectId, template })}
      {...{ projects, projectId, models, document, editing }}
      error={visibleError}
      feedback={feedback?.projectId === projectId ? feedback.message : undefined}
      busy={!state.matches("ready")}
      loading={
        !state.context.loaded && state.matches("working") && state.context.command.type === "REFRESH"
      }
      onEdit={(id) => send({ type: "EDIT", id })}
      onSave={(id, input) => send({ type: "SAVE", id, input })}
      onEnable={(id, enabled) => send({ type: "ENABLE", id, enabled })}
      onDelete={(id) => send({ type: "DELETE", id })}
      onRun={(id) => send({ type: "RUN", id })}
      onCancel={(id) => send({ type: "CANCEL", id })}
      onOpen={(id) => send({ type: "OPEN", id })}
      onRefresh={() => send({ type: "REFRESH" })}
    />
  )
}
