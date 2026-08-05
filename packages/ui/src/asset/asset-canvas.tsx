import type { ReactNode } from "react"
import type { AssetPayload } from "@jingler/core"
import type { FileDiffMetadata } from "@pierre/diffs"
import { FileSearch } from "lucide-react"
import { PierreFileDiffView } from "../diff/pierre-provider.js"
import {
  AssetError,
  AssetLoading,
  AssetTooLarge,
  AssetUnsupported,
  AssetView
} from "./asset-view.js"

export type AssetCanvasError =
  | { readonly type: "too-large"; readonly path: string; readonly size: number; readonly cap: number }
  | { readonly type: "unsupported"; readonly path: string }
  | { readonly type: "error"; readonly message: string }

export interface AssetCanvasProps {
  readonly selectedPath: string | null
  readonly payload?: AssetPayload
  readonly fileDiff?: FileDiffMetadata | null
  readonly loading?: boolean
  readonly error?: AssetCanvasError | null
  readonly onReveal?: () => void
  /** Renderer-owned native PDF host; its measured element stays inside this canvas. */
  readonly renderPdf?: (placeholder: ReactNode) => ReactNode
}

/** Every asset state renders in the same sibling canvas beside Pierre Trees. */
export function AssetCanvas({
  selectedPath,
  payload,
  fileDiff = null,
  loading = false,
  error = null,
  onReveal,
  renderPdf
}: AssetCanvasProps) {
  if (selectedPath === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-canvas px-5 text-center text-dim">
        <FileSearch className="size-6" aria-hidden />
        <p className="text-[12px]">Select a repository file to preview it.</p>
      </div>
    )
  }
  if (loading) return <AssetLoading />
  if (error?.type === "too-large") {
    return (
      <AssetTooLarge
        path={error.path}
        size={error.size}
        cap={error.cap}
        onReveal={onReveal}
      />
    )
  }
  if (error?.type === "unsupported") {
    return <AssetUnsupported path={error.path} onReveal={onReveal} />
  }
  if (error?.type === "error") {
    return <AssetError message={error.message} onReveal={onReveal} />
  }
  if (payload === undefined) return <AssetLoading />

  const changedSource =
    (payload.kind === "code" || payload.kind === "text") &&
    fileDiff !== null &&
    fileDiff.hunks.length > 0
  if (changedSource) {
    return (
      <PierreFileDiffView
        label={`${payload.path} changes`}
        fileDiff={fileDiff}
        className="h-full"
        options={{ diffStyle: "unified", stickyHeader: false }}
      />
    )
  }

  const view = <AssetView payload={payload} onReveal={onReveal} />
  return payload.kind === "pdf" && renderPdf !== undefined ? renderPdf(view) : view
}
