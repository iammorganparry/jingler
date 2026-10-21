/**
 * The Pull Request tab's Files sub-tab: the Changes renderer fed by this PR's
 * own `Github.files` / `Github.diff` (never the working tree), read-only.
 */
import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import type { Session } from "@jingler/core"
import { ChangedFilesExplorer, EmptyState, ReviewFileDiff } from "@jingler/ui"
import { diffBlocks, diffForPath } from "./review-diff-blocks.js"
import { rpc } from "./rpc-client.js"

const noop = () => {}

export function PrFilesPanel({
  session,
  prNumber,
  connected
}: {
  readonly session: Session
  readonly prNumber: number | null
  readonly connected: boolean
}) {
  const [selected, setSelected] = useState<string | null>(null)
  const query = useQuery({
    queryKey: ["github", "pr-files-tab", session.id, prNumber],
    enabled: prNumber !== null,
    queryFn: async () => {
      const [files, diff] = await Promise.all([
        rpc.githubFiles(session.id, prNumber ?? undefined),
        rpc.githubDiff(session.id, prNumber ?? undefined)
      ])
      return { files, diff }
    }
  })
  const files = query.data?.files
  const fileDiffs = useMemo(() => {
    const blocks = diffBlocks(query.data?.diff ?? "")
    return (files ?? []).map((file) => ({ path: file.path, diff: diffForPath(blocks, file.path) }))
  }, [files, query.data?.diff])
  const activePath = selected ?? files?.[0]?.path ?? null
  const file = files?.find((candidate) => candidate.path === activePath) ?? null

  return (
    <div data-testid="pr-files-panel" className="flex h-[560px] overflow-hidden rounded-lg border border-line bg-panel">
      <div className="w-72 flex-none overflow-y-auto border-r border-line">
        <ChangedFilesExplorer
          files={files ?? []}
          fileDiffs={fileDiffs}
          drafts={[]}
          activePath={activePath}
          onSelectFile={setSelected}
          loading={query.isLoading}
          error={query.error?.message ?? null}
          onRetry={() => void query.refetch()}
        />
      </div>
      <div className="min-w-0 flex-1">
        {file ? (
          <ReviewFileDiff
            file={file}
            diff={fileDiffs.find((entry) => entry.path === file.path)?.diff ?? ""}
            source="pr"
            drafts={[]}
            connected={connected}
            routeTargetSession={null}
            focused={false}
            onToggleFocus={noop}
            onAddDraft={noop}
            onRemoveDraft={noop}
            onToggleViewed={noop}
          />
        ) : (
          <EmptyState title="No files" description="This pull request has no changed files." />
        )}
      </div>
    </div>
  )
}
