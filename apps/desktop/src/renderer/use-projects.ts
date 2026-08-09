import type { Project } from "@jingler/core"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { rpc } from "./rpc-client.js"

const projectKey = (environmentId?: string) => ["projects", environmentId ?? "local"] as const

export function useProjects(environmentId?: string) {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: projectKey(environmentId),
    queryFn: () => rpc.projectsList(environmentId)
  })

  const publish = (project: Project): Project => {
    queryClient.setQueryData<ReadonlyArray<Project>>(
      projectKey(project.environmentId),
      (current = []) => [project, ...current.filter((candidate) => candidate.id !== project.id)]
    )
    return project
  }

  return {
    projects: query.data ?? [],
    loading: query.isLoading,
    error: query.error instanceof Error ? query.error.message : null,
    browse: rpc.projectsBrowse,
    register: (input: { path: string; name?: string }) =>
      rpc.projectsRegister({ ...input, ...(environmentId === undefined ? {} : { environmentId }) }).then(publish),
    createDirectory: (input: { path: string; name?: string }) =>
      rpc.projectsCreateDirectory({ ...input, ...(environmentId === undefined ? {} : { environmentId }) }).then(publish),
    clone: (input: { url: string; destination: string; name?: string }) =>
      rpc.projectsClone({ ...input, ...(environmentId === undefined ? {} : { environmentId }) }).then(publish),
    remove: (project: Project) =>
      rpc.projectsRemove(project.id, project.environmentId).then(() =>
        queryClient.setQueryData<ReadonlyArray<Project>>(
          projectKey(project.environmentId),
          (current = []) => current.filter((candidate) => candidate.id !== project.id)
        )
      ),
    refresh: () => query.refetch().then(() => undefined)
  }
}
