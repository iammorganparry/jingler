import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import type { PullRequestListItem } from "@jingler/core"
import { rpc } from "./rpc-client.js"

export function usePullRequestInbox(connected: boolean) {
  const [selected, setSelected] = useState<PullRequestListItem | null>(null)
  const list = useQuery({
    queryKey: ["github", "pr-inbox"],
    queryFn: rpc.githubPrInbox,
    enabled: connected
  })
  const detail = useQuery({
    queryKey: ["github", "pr-inbox", selected?.repository, selected?.number],
    queryFn: () => selected ? rpc.githubPrBySlug(selected.repository, selected.number) : null,
    enabled: connected && selected !== null
  })

  return {
    prs: list.data ?? [],
    selected,
    select: setSelected,
    detail: detail.data ?? null,
    loading: connected && list.isPending,
    detailLoading: detail.isPending && selected !== null,
    detailError: (detail.error as { message?: string } | null)?.message ?? null,
    error: connected
      ? (list.error as { message?: string } | null)?.message ?? null
      : "Connect GitHub to load pull requests."
  }
}
