import { useEffect, useId, useMemo, useState } from "react"
import { cn } from "../lib/cn.js"

/**
 * Renders a fenced ```mermaid block as an actual diagram.
 *
 * ## Why this is its own component (not inline in `MarkdownPre`)
 *
 * `mermaid` is heavy (hundreds of KB) and only a small fraction of plans contain
 * a diagram, so it is loaded with a dynamic `import()` INSIDE the effect — it
 * never enters the main renderer bundle and never runs until a diagram is on
 * screen. Rendering is also async (`mermaid.render` returns a promise), which a
 * plain synchronous Streamdown `pre` override cannot express.
 *
 * ## Theming
 *
 * The diagram is themed from the app's live `--sb-*` tokens rather than mermaid's
 * default palette, so it tracks whatever VS Code theme is active. Tokens are read
 * with `getComputedStyle` at render time. If a host has not resolved one yet, the
 * CSS variable reference itself remains the fallback, so diagram colours never
 * introduce a palette outside the existing `--sb-*` contract.
 *
 * ## Safety
 *
 * Plan source is attacker-influenceable (agents write it), so mermaid runs with
 * `securityLevel: "strict"` — it sanitizes labels through DOMPurify and forbids
 * click handlers/inline scripts before we inject the SVG. A malformed diagram
 * rejects rather than throwing up the tree, and we show an inline error card so
 * one bad fence never blanks the rest of the document.
 */

const cssVar = (name: `--sb-${string}`): string => {
  if (typeof document === "undefined") return `var(${name})`
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value.length > 0 ? value : `var(${name})`
}

/** Map the app's `--sb-*` tokens onto mermaid's `base` theme variables. */
const themeVariables = (): Record<string, string> => {
  const panel = cssVar("--sb-panel")
  const surface = cssVar("--sb-surface")
  const sunken = cssVar("--sb-sunken")
  const line = cssVar("--sb-line-strong")
  const text = cssVar("--sb-text-body")
  const blue = cssVar("--sb-blue")
  return {
    background: cssVar("--sb-canvas"),
    primaryColor: panel,
    secondaryColor: surface,
    tertiaryColor: sunken,
    primaryBorderColor: line,
    secondaryBorderColor: line,
    tertiaryBorderColor: line,
    primaryTextColor: text,
    secondaryTextColor: text,
    tertiaryTextColor: text,
    lineColor: line,
    textColor: text,
    nodeBorder: line,
    clusterBkg: surface,
    clusterBorder: line,
    titleColor: text,
    edgeLabelBackground: panel,
    actorBorder: line,
    actorBkg: panel,
    labelTextColor: text,
    fontFamily: "inherit",
    fontSize: "13px",
    primaryColorHover: blue
  }
}

function DiagramError({ message }: { message: string }) {
  return (
    <div className="my-3 overflow-hidden rounded-md border border-red/40 bg-red/[0.08]">
      <div className="border-b border-red/30 px-3 py-1.5 text-[11px] font-medium text-red">
        Diagram error
      </div>
      <pre className="overflow-x-auto px-3 py-2 font-mono text-[11.5px] leading-[1.6] text-text-body">
        {message}
      </pre>
    </div>
  )
}

function DiagramPending() {
  return (
    <div className="my-3 rounded-md border border-line bg-panel px-3 py-4 text-[12px] text-dim">
      Rendering diagram…
    </div>
  )
}

export function MermaidDiagram({ source, className }: { source: string; className?: string }) {
  // `useId` yields ids containing ":" — invalid for the DOM id mermaid uses to
  // stamp its <svg>. Strip everything but word chars.
  const rawId = useId()
  const domId = useMemo(() => `mermaid-${rawId.replace(/[^a-zA-Z0-9]/g, "")}`, [rawId])
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const trimmed = source.trim()
    if (trimmed.length === 0) {
      setSvg(null)
      setError(null)
      return
    }
    void (async () => {
      try {
        const mermaid = (await import("mermaid")).default
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "base",
          look: "handDrawn",
          handDrawnSeed: 1,
          themeVariables: themeVariables()
        })
        // `render` also validates; a syntax error rejects here.
        const result = await mermaid.render(domId, trimmed)
        if (!cancelled) {
          setSvg(result.svg)
          setError(null)
        }
      } catch (cause) {
        if (!cancelled) {
          setSvg(null)
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [domId, source])

  if (error !== null) return <DiagramError message={error} />
  if (svg === null) return <DiagramPending />

  return (
    <div
      // mermaid (strict mode) sanitizes this SVG through DOMPurify before it
      // reaches us; see the component doc comment.
      className={cn("sb-mermaid my-3 flex justify-center overflow-x-auto", className)}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized mermaid SVG output
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
