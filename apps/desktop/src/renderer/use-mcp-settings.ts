import type { McpConfigEntry, McpImportSourceId, McpServerStatus } from "@jingler/core"
import type { McpSettingsProps } from "@jingler/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useState } from "react"
import { rpc } from "./rpc-client.js"

export const mcpKey = ["mcp-servers"] as const

/**
 * Settings › MCP servers, backed by `~/jingler/mcp.json` in the main process.
 * The list is the redacted view; probing is on demand (it spawns stdio server
 * commands, so never on mount).
 */
export function useMcpSettings(): McpSettingsProps {
  const queryClient = useQueryClient()
  const [statuses, setStatuses] = useState<ReadonlyArray<McpServerStatus> | null>(null)

  const query = useQuery({
    queryKey: mcpKey,
    queryFn: () => rpc.mcpList(),
    staleTime: Infinity
  })

  const invalidate = () => queryClient.invalidateQueries({ queryKey: mcpKey })

  const probeMutation = useMutation({
    mutationFn: () => rpc.mcpStatus(),
    onSuccess: setStatuses
  })
  const probeRun = probeMutation.mutate
  const probe = useCallback(() => probeRun(), [probeRun])

  const setEnabled = useCallback(
    async (name: string, enabled: boolean) => {
      await rpc.mcpSetEnabled(name, enabled)
      await invalidate()
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queryClient]
  )

  const remove = useCallback(
    async (name: string) => {
      await rpc.mcpRemove(name)
      await invalidate()
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queryClient]
  )

  const add = useCallback(
    async (name: string, entry: McpConfigEntry) => {
      await rpc.mcpWrite(name, entry)
      await invalidate()
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queryClient]
  )

  const applyImport = useCallback(
    async (source: McpImportSourceId, names: ReadonlyArray<string>) => {
      const imported = await rpc.mcpApplyImport(source, names)
      await invalidate()
      return imported
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queryClient]
  )

  return {
    servers: query.data?.servers ?? [],
    parseError: query.data?.error ?? null,
    loading: query.isLoading,
    statuses,
    probing: probeMutation.isPending,
    probe,
    setEnabled,
    remove,
    add,
    reveal: () => rpc.mcpReveal(),
    importCandidates: (source) => rpc.mcpImportCandidates(source),
    applyImport
  }
}
