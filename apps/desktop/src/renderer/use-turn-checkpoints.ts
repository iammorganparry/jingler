import { keepPreviousData, useQuery } from "@tanstack/react-query"
import type { Session } from "@jingler/core"
import { rpc } from "./rpc-client.js"

/**
 * Checkpoint ids the workspace captured at the start of each agent turn, oldest first.
 * Rail turn N maps to the N-th id.
 * ponytail: positional match — a steered/queued prompt that shares a turn skews it; key by message id if that matters.
 */
export function useTurnCheckpointIds(session: Session, busy: boolean): ReadonlyArray<string> {
  const { data } = useQuery({
    // `busy` flips on both sides of a turn, which is exactly when a new checkpoint can exist.
    queryKey: ["workspace-checkpoints", session.id, busy],
    queryFn: () => rpc.workspaceCheckpointsList(session.id),
    enabled: session.checkpointSafeMode === true,
    placeholderData: keepPreviousData
  })
  return (data ?? [])
    .filter((checkpoint) => checkpoint.label.startsWith("Before agent turn"))
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((checkpoint) => checkpoint.id)
}
