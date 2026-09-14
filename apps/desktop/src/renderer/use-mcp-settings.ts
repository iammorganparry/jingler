import type { McpConfigEntry, McpImportSourceId, McpServerStatus } from "@jingler/core"
import type { McpSettingsProps } from "@jingler/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { rpc } from "./rpc-client.js"

const mcpKey = ["mcp-servers"] as const

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
    refetchInterval: 5_000
  })

  const invalidate = () => {
    setStatuses(null)
    return queryClient.invalidateQueries({ queryKey: mcpKey })
  }

  const probeMutation = useMutation({
    mutationFn: () => rpc.mcpStatus(),
    onSuccess: setStatuses
  })

  return {
    servers: query.data?.servers ?? [],
    parseError: query.data?.error ?? null,
    loading: query.isLoading,
    statuses,
    probing: probeMutation.isPending,
    probe: () => probeMutation.mutate(),
    setEnabled: async (name: string, enabled: boolean) => {
      await rpc.mcpSetEnabled(name, enabled)
      await invalidate()
    },
    remove: async (name: string) => {
      await rpc.mcpRemove(name)
      await invalidate()
    },
    add: async (name: string, entry: McpConfigEntry) => {
      await rpc.mcpWrite(name, entry)
      await invalidate()
    },
    setApiKey: async (name: string, apiKey: string) => {
      await rpc.mcpSetApiKey(name, apiKey)
      await invalidate()
    },
    startAuthorization: async (name: string) => {
      const { authorizationUrl } = await rpc.mcpStartAuthorization(name)
      await window.jingler.openExternal(authorizationUrl)
      await invalidate()
    },
    reveal: () => rpc.mcpReveal(),
    importCandidates: (source: McpImportSourceId) => rpc.mcpImportCandidates(source),
    applyImport: async (source: McpImportSourceId, names: ReadonlyArray<string>) => {
      const imported = await rpc.mcpApplyImport(source, names)
      await invalidate()
      return imported
    }
  }
}
