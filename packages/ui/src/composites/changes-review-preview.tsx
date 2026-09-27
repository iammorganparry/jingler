/**
 * Stories-only composition of the changes review as the app lays it out: the
 * Explorer filtered to changed files, the opened file's review diff, and the
 * review tray once drafts exist. Not exported from the package.
 */
import type { AdversarialReview, PrFileChange, PrReviewThread } from "@jingler/core"
import { useState } from "react"
import {
  ChangedFilesExplorer,
  ReviewFileDiff,
  ReviewSidebar,
  type ReviewDraftInput,
  type ReviewSource
} from "./changes-review.js"
import type { ReviewDraft } from "./review-tray.js"

export interface ChangesReviewPreviewProps {
  readonly files: readonly PrFileChange[]
  readonly fileDiffs: readonly { readonly path: string; readonly diff: string }[]
  readonly activePath: string | null
  readonly source: ReviewSource
  readonly drafts: readonly ReviewDraft[]
  readonly reviewThreads?: readonly PrReviewThread[]
  readonly review?: AdversarialReview | null
  readonly routeTargetSession: string | null
  readonly connected: boolean
  readonly onSelectFile?: (path: string) => void
  readonly onAddDraft?: (draft: ReviewDraftInput) => void
  readonly onRevertLines?: (range: { path: string; startLine: number; endLine: number }) => void
  readonly onRevertFile?: (path: string) => void
  readonly onSendFindingToAgent?: (findingId: string) => void
  readonly sentFindingIds?: ReadonlySet<string>
}

export function ChangesReviewPreview(props: ChangesReviewPreviewProps) {
  const [activePath, setActivePath] = useState(props.activePath ?? props.files[0]?.path ?? null)
  const [focused, setFocused] = useState(false)
  const file = props.files.find((candidate) => candidate.path === activePath) ?? null
  const diff = props.fileDiffs.find((entry) => entry.path === activePath)?.diff ?? ""
  return (
    <div className="flex h-full min-h-0 w-full">
      {focused ? null : (
        <div className="w-[260px] flex-none border-r border-hairline bg-panel">
          <ChangedFilesExplorer
            files={props.files}
            fileDiffs={props.fileDiffs}
            drafts={props.drafts}
            reviewThreads={props.reviewThreads}
            review={props.review}
            activePath={activePath}
            onSelectFile={(path) => {
              setActivePath(path)
              props.onSelectFile?.(path)
            }}
          />
        </div>
      )}
      <div className="min-w-0 flex-1">
        {file === null ? null : (
          <ReviewFileDiff
            file={file}
            diff={diff}
            source={props.source}
            drafts={props.drafts}
            reviewThreads={props.reviewThreads}
            review={props.review}
            sentFindingIds={props.sentFindingIds}
            onSendFindingToAgent={props.onSendFindingToAgent}
            connected={props.connected}
            routeTargetSession={props.routeTargetSession}
            focused={focused}
            onToggleFocus={() => setFocused((value) => !value)}
            onAddDraft={props.onAddDraft ?? (() => {})}
            onRemoveDraft={() => {}}
            onToggleViewed={() => {}}
            onRevertLines={props.onRevertLines}
            onRevertFile={props.onRevertFile}
          />
        )}
      </div>
      {focused ? null : (
        <ReviewSidebar
          drafts={props.drafts}
          source={props.source}
          connected={props.connected}
          review={props.review}
          sentFindingIds={props.sentFindingIds}
          onSendFindingToAgent={props.onSendFindingToAgent}
          routeTargetSession={props.routeTargetSession}
          paths={new Set(props.files.map((candidate) => candidate.path))}
          onRemoveDraft={() => {}}
          onFinishReview={() => {}}
        />
      )}
    </div>
  )
}
