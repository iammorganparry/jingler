import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/react"
import type { RoutineDocument } from "@jingler/core"
import { ProjectWorkflowSettings } from "./project-workflow-settings.js"
import { RoutinesSettingsView } from "./routines-settings-view.js"
import { settingsDocument, settingsModels, settingsProjects } from "./project-settings-fixtures.js"
const meta = {
  title: "Settings/Projects",
  component: ProjectWorkflowSettings,
  args: { projects: settingsProjects, onSave: async () => {} },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ProjectWorkflowSettings>
export default meta
type Story = StoryObj<typeof meta>
function UnifiedProjects() {
  const [projects, setProjects] = useState(settingsProjects)
  const [document, setDocument] = useState<RoutineDocument>(settingsDocument)
  const [editing, setEditing] = useState<string | undefined>()
  const [notice, setNotice] = useState("")
  return (
    <div className="mx-auto max-w-4xl bg-panel p-4 sm:p-8">
      <ProjectWorkflowSettings
        projects={projects}
        onSave={async (input) =>
          setProjects((current) =>
            current.map((project) =>
              project.id === input.projectId
                ? { ...project, workflow: { ...input, approvedDigest: "story-approved" } }
                : project,
            ),
          )
        }
        routines={(projectId) => (
          <RoutinesSettingsView
            {...{ projects, projectId, document, editing }}
            models={settingsModels}
            busy={false}
            loading={false}
            error={null}
            onEdit={setEditing}
            onSave={(id, input) => {
              const routine = {
                ...input,
                id: id ?? crypto.randomUUID(),
                revision: crypto.randomUUID(),
                createdAt: Date.now(),
                updatedAt: Date.now(),
                nextAt: input.enabled ? input.schedule.at : null,
                workflowDigest: null,
              }
              setDocument((current) => ({
                ...current,
                routines: [...current.routines.filter((item) => item.id !== id), routine],
              }))
              setEditing(routine.id)
              setNotice("Routine saved.")
            }}
            onEnable={(id, enabled) =>
              setDocument((current) => ({
                ...current,
                routines: current.routines.map((item) =>
                  item.id === id ? { ...item, enabled, revision: crypto.randomUUID() } : item,
                ),
              }))
            }
            onDelete={(id) =>
              setDocument((current) => ({
                ...current,
                routines: current.routines.filter((item) => item.id !== id),
              }))
            }
            onRun={() => setNotice("Run requested using saved settings.")}
            onCancel={(id) =>
              setDocument((current) => ({
                ...current,
                runs: current.runs.map((run) => (run.id === id ? { ...run, status: "cancelled" } : run)),
              }))
            }
            onOpen={(id) => setNotice(`Open workspace ${id}`)}
            onRefresh={() => setNotice("History refreshed.")}
          />
        )}
      />
      {notice && (
        <p role="status" className="mt-4 text-sm text-dim">
          {notice}
        </p>
      )}
    </div>
  )
}
export const Unified: Story = { render: () => <UnifiedProjects /> }
