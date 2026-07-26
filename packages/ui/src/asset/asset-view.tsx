import { useEffect, useMemo, useRef, useState } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { FileWarning, FolderOpen, TriangleAlert } from "lucide-react"
import type { AssetPayload } from "@starbase/core"
import { toShikiTheme } from "@starbase/themes"
import { cn } from "../lib/cn.js"
import { Spinner } from "../components/loading.js"
import { Markdown } from "../components/markdown.js"
import { type Token, tokenizeLines } from "../diff/highlight.js"
import { HighlightedLine } from "../diff/use-highlight.js"
import { useOptionalThemeTokens, useThemeSyntax } from "../theme-provider.js"
import { CsvTable } from "./csv-table.js"

const LINE_HEIGHT = 20

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
      return <CodeView text={payload.text} language={payload.language} className={className} />
    case "csv":
      return <CsvTable text={payload.text} className={className} />
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
 * The active theme in shiki's shape, or null before it has loaded.
 *
 * Optional (not strict) on purpose: Storybook and the test suite mount no theme
 * provider, and both correctly fall back to shiki's bundled One Dark Pro. Kept
 * in step with `useShikiTheme` in the diff engine, which does the same.
 */
const useShikiTheme = () => {
  const raw = useThemeSyntax()
  const tokens = useOptionalThemeTokens()
  return useMemo(() => (raw && tokens ? toShikiTheme(raw, tokens) : null), [raw, tokens])
}

/**
 * Highlight a whole file once and hand each row its own tokens.
 *
 * Reuses the diff engine's `tokenizeLines` — the same shared highlighter
 * singleton, so no second Shiki instance and no second theme parse. A file is
 * one document (unlike a diff's interleaved hunks), which is exactly what
 * `tokenizeLines` already tokenizes.
 *
 * Returns null until the grammar lands, forever for a language we don't bundle,
 * and on any failure — callers then render plain monospace, which is the whole
 * fallback contract.
 */
const useCodeHighlight = (
  lines: ReadonlyArray<string>,
  language: string | null
): ReadonlyArray<ReadonlyArray<Token>> | null => {
  const [tokens, setTokens] = useState<ReadonlyArray<ReadonlyArray<Token>> | null>(null)
  // Key off the CONTENT, not the array identity: `lines` is derived and gets a
  // fresh identity every render, which would otherwise re-tokenize forever.
  const key = useMemo(() => lines.join("\n"), [lines])
  const theme = useShikiTheme()

  useEffect(() => {
    if (language === null) {
      setTokens(null)
      return
    }
    // The grammar loads async; the user can switch files before it resolves.
    // Without this guard a late resolve paints one file's tokens onto another's.
    let live = true
    void tokenizeLines(key.split("\n"), language, theme).then((result) => {
      if (live) setTokens(result)
    })
    return () => {
      live = false
    }
  }, [key, language, theme])

  return tokens
}

/**
 * A monospace, line-numbered code/text view. Virtualized like the diff so a 5 MB
 * log (the text cap) doesn't mount one element per line, and highlighted through
 * the shared Shiki singleton with a plain-text fallback baked in.
 */
function CodeView({
  text,
  language,
  className
}: {
  text: string
  language: string | null
  className?: string
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const lines = useMemo(() => text.split("\n"), [text])
  const tokens = useCodeHighlight(lines, language)

  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => LINE_HEIGHT,
    overscan: 24
  })

  const gutterWidth = `${String(lines.length).length + 1}ch`

  return (
    <div
      ref={scrollRef}
      className={cn("h-full overflow-auto bg-canvas font-mono text-[12px] leading-[20px]", className)}
    >
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => (
          <div
            key={item.index}
            className="absolute inset-x-0 top-0 flex"
            style={{ height: item.size, transform: `translateY(${item.start}px)` }}
          >
            <span
              className="shrink-0 select-none pr-3 pl-3 text-right tabular-nums text-dim"
              style={{ width: gutterWidth }}
            >
              {item.index + 1}
            </span>
            <span className="whitespace-pre pr-4 text-text-body">
              <HighlightedLine text={lines[item.index] ?? ""} tokens={tokens?.[item.index]} />
            </span>
          </div>
        ))}
      </div>
    </div>
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
