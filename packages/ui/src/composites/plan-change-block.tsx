import { jinglerDark, toTokens } from "@jingler/themes"
import type { FileDiffMetadata } from "@pierre/diffs"
import { FileCode2 } from "lucide-react"
import { useMemo } from "react"
import { useOpenPath } from "../asset/open-asset-context.js"
import { normalizeDiffPreviewPatch, parsePierreFileDiffs } from "../diff/parse.js"
import { createPierreFileDiff } from "../diff/pierre-model.js"
import { PierreFileDiffView, PierreProvider } from "../diff/pierre-provider.js"
import { useOptionalThemeTokens, useThemeSyntax } from "../theme-provider.js"

const FALLBACK_TOKENS = toTokens(jinglerDark)

function PlanDiff({ label, fileDiff, wrap = false }: { label: string; fileDiff: FileDiffMetadata; wrap?: boolean }) {
  const theme = useThemeSyntax()
  const tokens = useOptionalThemeTokens()
  return (
    <PierreProvider theme={theme} tokens={tokens ?? FALLBACK_TOKENS}>
      <PierreFileDiffView label={label} fileDiff={fileDiff} options={{ disableFileHeader: true, stickyHeader: false, wrap }} />
    </PierreProvider>
  )
}

export interface PlanChangeBlockProps {
  readonly path: string
  readonly patch: string
}

/** A proposed unified diff for one file, with its path linked to the Files tab. */
export function PlanChangeBlock({ path, patch }: PlanChangeBlockProps) {
  const open = useOpenPath(path)
  const fileDiff = useMemo(
    () => parsePierreFileDiffs(normalizeDiffPreviewPatch(patch, path))[0] ?? null,
    [patch, path]
  )

  return (
    <figure className="my-3 overflow-hidden rounded-md border border-line" data-plan-change={path}>
      <figcaption className="flex items-center gap-2 border-b border-line bg-panel px-3 py-1.5 font-mono text-[11.5px]">
        <FileCode2 className="size-3.5 text-muted-foreground" aria-hidden="true" />
        {open === null ? (
          <span className="text-text-bright">{path}</span>
        ) : (
          <button
            type="button"
            onClick={open}
            aria-label={`Open ${path}`}
            className="text-blue underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            {path}
          </button>
        )}
      </figcaption>
      {fileDiff === null ? (
        <pre className="overflow-x-auto px-3 py-2 font-mono text-[11.5px] text-text-body">{patch}</pre>
      ) : (
        <PlanDiff label={`Proposed change to ${path}`} fileDiff={fileDiff} />
      )}
    </figure>
  )
}

export interface PlanRevisionDiffProps {
  readonly path: string
  readonly before: string
  readonly after: string
}

/** What changed in the plan file between the previous review and this one. */
export function PlanRevisionDiff({ path, before, after }: PlanRevisionDiffProps) {
  const fileDiff = useMemo(
    () => createPierreFileDiff({ status: "modified", path, before, after }),
    [path, before, after]
  )
  return <PlanDiff label="Changes since the previous revision" fileDiff={fileDiff} wrap />
}
