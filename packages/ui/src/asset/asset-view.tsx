import { useMemo } from "react"
import { FileWarning, FolderOpen, TriangleAlert } from "lucide-react"
import type { AssetPayload } from "@jingler/core"
import { cn } from "../lib/cn.js"
import { Spinner } from "../components/loading.js"
import { Markdown } from "../components/markdown.js"
import { createPierreFileContents } from "../diff/pierre-model.js"
import { PierreFileView } from "../diff/pierre-provider.js"
import { CsvTable } from "./csv-table.js"

/**
 * Above this size we refuse to build the table rather than freeze the window.
 *
 * `parseCsv` is a single-threaded, char-by-char loop that also allocates a string
 * per cell and an array per row; on the render path a ~2 MB file already costs
 * roughly 100–200 ms, and the csv cap is 25 MB — an order of magnitude past that,
 * seconds of a blocked main thread before the first row paints. The virtualizer
 * only bounds DOM cost, not parse cost, so the fix is to not start. Well under the
 * read cap, so large-but-valid exports get an honest refusal (with Reveal in
 * Finder) instead of a hang, and we never truncate — a half-shown CSV that looks
 * whole is worse.
 */
const CSV_PARSE_CAP = 2 * 1024 * 1024

/**
 * The Preview dock's file viewer. Switches on the discriminated
 * `AssetPayload.kind` so TypeScript narrows each branch's extra fields — no `!`
 * and no unreachable default.
 */
export function AssetView({
  payload,
  onReveal,
  className
}: {
  payload: AssetPayload
  onReveal?: () => void
  className?: string
}) {
  switch (payload.kind) {
    case "markdown":
      return (
        <div className={cn("h-full overflow-auto bg-canvas px-5 py-4", className)}>
          <Markdown>{payload.text}</Markdown>
        </div>
      )
    case "code":
    case "text":
      return <AssetSourceFile payload={payload} className={className} />
    case "csv":
      // Guard the synchronous parse: over the cap we offer Finder rather than
      // freezing the renderer for seconds building a table nobody can scroll yet.
      return payload.size > CSV_PARSE_CAP ? (
        <AssetNotice
          icon={<FileWarning className="size-6 text-yellow" aria-hidden />}
          title="Too large to show as a table"
          detail={`${payload.path} is ${formatBytes(payload.size)} — parsing it inline would freeze the window. Open it in another tool instead.`}
          onReveal={onReveal}
        />
      ) : (
        <CsvTable text={payload.text} className={className} />
      )
    case "image":
      return (
        <div className={cn("flex h-full items-center justify-center overflow-auto bg-canvas p-4", className)}>
          {/* An SVG goes through <img>, never inline / never
              dangerouslySetInnerHTML: a data-URL image is a passive resource, so
              an SVG smuggling a <script> can't execute the way an inlined one
              would. */}
          <img
            src={`data:${payload.mediaType};base64,${payload.base64}`}
            alt={payload.path}
            className="max-h-full max-w-full object-contain"
          />
        </div>
      )
    case "pdf":
      return (
        <div
          data-testid="asset-pdf-placeholder"
          className={cn("flex h-full items-center justify-center gap-2 bg-canvas text-dim", className)}
        >
          {/* Deliberately just a hole in the layout: main paints a native
              WebContentsView over this rect, so the renderer must claim the
              space without drawing anything the PDF would sit on top of. */}
          <Spinner size={13} />
          <span className="text-[12px]">Loading PDF…</span>
        </div>
      )
  }
}

/**
 * Clean source belongs to Pierre File. Its worker-backed highlighter and built-in
 * virtual window replace the previous Jingler row virtualizer/token hook.
 */
function AssetSourceFile({
  payload,
  className
}: {
  payload: Extract<AssetPayload, { readonly text: string }>
  className?: string
}) {
  const file = useMemo(
    () =>
      createPierreFileContents({
        path: payload.path,
        contents: payload.text,
        language: payload.language ?? "text",
        revision: payload.size
      }),
    [payload.language, payload.path, payload.size, payload.text]
  )

  return (
    <PierreFileView
      label={`${payload.path} source`}
      file={file}
      className={cn("h-full bg-canvas", className)}
      options={{ lineNumbers: true, stickyHeader: false }}
    />
  )
}

/**
 * Bytes as a short human string ("42.1 MB"). Base-1024, one decimal above the
 * kilobyte so the "too large" state reads at a glance instead of showing a raw
 * eight-digit count.
 */
export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(1)} ${units[unit]}`
}

/** A framed, centred message with an optional "Reveal in Finder" escape hatch. */
function AssetNotice({
  icon,
  title,
  detail,
  onReveal
}: {
  icon: React.ReactNode
  title: string
  detail?: string
  onReveal?: () => void
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-canvas px-6 text-center">
      {icon}
      <div className="space-y-1">
        <p className="text-[13px] font-medium text-text-bright">{title}</p>
        {detail && <p className="text-[12px] text-dim">{detail}</p>}
      </div>
      {onReveal && (
        <button
          type="button"
          onClick={onReveal}
          className="mt-1 inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-3 py-1.5 text-[12px] text-text-body hover:bg-hover"
        >
          <FolderOpen className="size-3.5" aria-hidden />
          Reveal in Finder
        </button>
      )}
    </div>
  )
}

/** Shown while an asset's bytes are being read off disk. */
export function AssetLoading({ className }: { className?: string }) {
  return (
    <div className={cn("flex h-full items-center justify-center gap-2 bg-canvas text-dim", className)}>
      <Spinner size={13} />
      <span className="text-[12px]">Loading…</span>
    </div>
  )
}

/**
 * The escape hatch when a file exceeds its kind's size cap — we refuse to pull
 * the bytes across IPC (see `ASSET_SIZE_CAP`) and offer Finder instead.
 */
export function AssetTooLarge({
  path,
  size,
  cap,
  onReveal
}: {
  path: string
  size: number
  cap: number
  onReveal?: () => void
}) {
  return (
    <AssetNotice
      icon={<FileWarning className="size-6 text-yellow" aria-hidden />}
      title="File too large to preview"
      detail={`${path} is ${formatBytes(size)} — over the ${formatBytes(cap)} preview limit.`}
      onReveal={onReveal}
    />
  )
}

/** A path whose extension maps to no viewer. */
export function AssetUnsupported({ path, onReveal }: { path: string; onReveal?: () => void }) {
  return (
    <AssetNotice
      icon={<FileWarning className="size-6 text-dim" aria-hidden />}
      title="No preview available"
      detail={`${path} can't be previewed here.`}
      onReveal={onReveal}
    />
  )
}

/** The read failed — a deleted file, a permission error, a decode error. */
export function AssetError({ message, onReveal }: { message: string; onReveal?: () => void }) {
  return (
    <AssetNotice
      icon={<TriangleAlert className="size-6 text-red" aria-hidden />}
      title="Couldn't open this file"
      detail={message}
      onReveal={onReveal}
    />
  )
}
