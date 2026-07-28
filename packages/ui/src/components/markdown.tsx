import { createContext, isValidElement, useContext, useMemo, type ReactNode } from "react"
import { Streamdown, defaultUrlTransform, type AllowedTags, type MathPlugin, type UrlTransform } from "streamdown"
import rehypeKatex from "rehype-katex"
import remarkMath from "remark-math"
import { cn } from "../lib/cn.js"
import { DiffPeek } from "./diff-peek.js"
import { HtmlPreview } from "./html-preview.js"
import { useOpenAsset, useOpenPath } from "../asset/open-asset-context.js"
import { resolveOpenablePath } from "../asset/path-detect.js"

/**
 * Math support: `remark-math` parses `$…$` / `$$…$$` and `rehype-katex` renders
 * it to KaTeX HTML (styled by `katex/dist/katex.min.css`, imported in
 * `globals.css`).
 *
 * Declared via Streamdown's `plugins.math` and NOT via the `remarkPlugins` /
 * `rehypePlugins` props. Those props REPLACE Streamdown's defaults rather than
 * extending them, and the defaults are load-bearing:
 *   rehype: rehype-raw, rehype-sanitize, rehype-harden
 *   remark: remark-gfm, codeMeta
 * Dropping `rehype-raw` doesn't merely leave HTML unrendered — Streamdown
 * detects its absence and actively rewrites raw HTML into literal text, so
 * GitHub review bodies (Greptile's `<details>` blocks and `<picture>` badges)
 * render as visible source. Dropping `remark-gfm` silently kills tables,
 * strikethrough, task lists and autolinks everywhere.
 *
 * `plugins.math` appends after the defaults AND preserves their array identity,
 * which `allowedTags` below requires in order to take effect at all.
 */
const MATH_PLUGIN = {
  name: "katex",
  type: "math",
  remarkPlugin: remarkMath,
  rehypePlugin: rehypeKatex
} as const satisfies MathPlugin

const PLUGINS = { math: MATH_PLUGIN }

/**
 * Tags GitHub review bots rely on that rehype-sanitize's default schema strips.
 * Greptile folds its "Prompt To Fix With AI" into a `<details>` and ships its
 * P1/severity and "Fix in …" badges as `<picture><source>` + `<img>`.
 *
 * Streamdown merges this into the sanitize schema with a SHALLOW spread
 * (`attributes: { ...defaultSchema.attributes, ...allowedTags }`), so an entry
 * here REPLACES that tag's default attribute list rather than adding to it.
 * Never list a tag the default schema already handles: `img: ["align"]` would
 * drop `src` from `img`'s defaults, and rehype-harden then renders the
 * src-less image as "[Image blocked]". `align`/`alt` need no entry anyway —
 * they're already in the schema's global `"*"` attribute list.
 */
const ALLOWED_TAGS: AllowedTags = {
  details: [],
  summary: [],
  picture: [],
  // `srcSet` is the one attribute here that the global `"*"` list lacks.
  source: ["srcSet", "srcset", "type"]
}

/**
 * Our fenced-block overrides. A ```diff block renders as a `DiffPeek`, and a
 * ```html block renders as a per-block, opt-in sandboxed `HtmlPreview`.
 *
 * This MUST be a stable module-scope component (not an inline closure in
 * `Markdown`): Streamdown re-runs its pipeline on every render, so an inline
 * `pre` would be a new component TYPE each time and React would UNMOUNT the block
 * — resetting `HtmlPreview`'s Code/Preview toggle whenever the transcript
 * re-renders (e.g. the virtualizer re-measuring on a height change).
 */
/**
 * True inside a fenced block.
 *
 * `MarkdownCode` needs to know, and cannot tell from its own props: a fence with
 * NO language carries no `language-…` class, so it is indistinguishable from an
 * inline span. Without this, a fence whose entire body is a path (agents write
 * those constantly) turned into one giant link.
 */
const InsideFence = createContext(false)

function MarkdownPre({ children }: { children?: ReactNode }) {
  const code = isValidElement<{ className?: string; children?: unknown }>(children) ? children : null
  const lang = /language-(\w+)/.exec(code?.props.className ?? "")?.[1]
  if (lang === "diff") {
    const text = String(code?.props.children ?? "").replace(/\n$/, "")
    return (
      <div className="my-3 overflow-hidden rounded-md border border-line">
        <DiffPeek preview={text} />
      </div>
    )
  }
  if (lang === "html") {
    // Opt-in per-block: defaults to the raw Code view (plain text); the operator
    // can switch to a sandboxed Preview. See HtmlPreview.
    const text = String(code?.props.children ?? "").replace(/\n$/, "")
    return <HtmlPreview code={text} />
  }
  // Non-diff code blocks: plain, styled by `.sb-md pre` (no chrome).
  return (
    <InsideFence.Provider value={true}>
      <pre>{children}</pre>
    </InsideFence.Provider>
  )
}

/**
 * An inline `code` span that names a real file becomes a link into the Preview
 * dock; everything else renders exactly as it always did.
 *
 * The gate is `useOpenPath`, which requires the token to be in the session's
 * worktree — see `path-detect.ts` for why shape alone is not enough. With no
 * `OpenAssetProvider` above it (Storybook, component tests) this is a plain
 * `<code>`, unchanged.
 *
 * Module-scope for the same reason `MarkdownPre` is: Streamdown re-runs its
 * pipeline on every render, so an inline closure would be a new component TYPE
 * each time and React would unmount and remount every code span in the message.
 */
function MarkdownCode({ children, ...rest }: { children?: ReactNode; className?: string }) {
  // Only bare inline spans are candidates: a fenced block's body is not a path,
  // however much of it happens to look like one.
  const fenced = useContext(InsideFence)
  const text = typeof children === "string" ? children : null
  const open = useOpenPath(fenced || rest.className ? null : text)
  if (!open || text === null) return <code {...rest}>{children}</code>
  return (
    <button type="button" onClick={open} title={`Open ${text}`} className="sb-md-path">
      <code {...rest}>{children}</code>
    </button>
  )
}


/**
 * A markdown link whose target is a file in this worktree opens in the Preview
 * dock; every other link renders as Streamdown's own anchor.
 *
 * ## Why this has to be a component override
 *
 * Streamdown's link component renders a `<button>`, not an `<a>`, whenever
 * link-safety is on — the href lives in props and never reaches the DOM. So
 * intercepting clicks on the rendered output cannot work: by then the path is
 * gone. The component layer is the only place the href still exists.
 *
 * ## What this costs, deliberately
 *
 * Streamdown's built-in "are you sure?" modal for external links is not
 * reproduced here; an external link is rendered as a plain
 * `target="_blank" rel="noreferrer"` anchor. Reproducing the modal would mean
 * duplicating the library's internals — including its context shape — and that
 * duplication silently rotting on the next upgrade is a worse failure than the
 * one it prevents. Hardening is UNAFFECTED either way: `rehype-harden` runs in
 * the rehype pipeline, long before any component sees an href, which is why the
 * `javascript:` test still passes.
 *
 * `data-streamdown="link"` is kept because a test asserts it — dropping it once
 * already made a real external link stop reading as one.
 *
 * ## `target="_blank"` here is only safe because main refuses it
 *
 * An href in agent markdown is attacker-influenceable, and Electron hands a
 * `window.open`ed child the OPENER'S `webPreferences` — including the preload
 * that exposes the RPC bridge. The reason this renders a plain anchor rather
 * than routing through an injected opener is that `setWindowOpenHandler` in
 * `apps/desktop/src/main/index.ts` denies every window-open request outright and
 * hands http(s) to `shell.openExternal`, so the click lands in the user's real
 * browser and no Electron window is ever created. Deleting that handler
 * re-opens the hole for every `Markdown` in the app, not just this one.
 */
function MarkdownAnchor({
  href,
  children,
  className,
  node: _node,
  ...rest
}: {
  href?: string
  children?: ReactNode
  className?: string
  node?: unknown
}) {
  const open = useOpenPath(href)
  if (open) {
    return (
      <button type="button" onClick={open} title={`Open ${href}`} className="sb-md-path">
        {children}
      </button>
    )
  }
  return (
    <a
      className={cn("wrap-anywhere font-medium underline", className)}
      data-streamdown="link"
      href={href}
      rel="noreferrer"
      target="_blank"
      {...rest}
    >
      {children}
    </a>
  )
}

const COMPONENTS = { pre: MarkdownPre, code: MarkdownCode, a: MarkdownAnchor }

/**
 * Unwrap no-op `<a href="#">…</a>` anchors.
 *
 * Greptile wraps its severity badge in one (`<a href="#"><img alt="P1" …></a>`).
 * rehype-harden can't validate a bare "#": its fragment fast-path compares
 * `new URL("#", base).hash` — which is `""` — against `"#"`, fails, then falls
 * through to `new URL("#")`, which throws. The href is judged unsafe and the
 * badge renders with a literal "[blocked]" stamped next to it. Such an anchor
 * targets nothing, so unwrapping it is lossless and drops the artifact.
 *
 * `href` must appear as a real attribute — preceded by whitespace and holding
 * exactly "#" — so this can't misfire on a link that merely CONTAINS that text
 * (`<a href="https://x" data-href="#">`) and silently strip it. `#section` is a
 * genuine jump link and harden accepts it, so it's deliberately not matched.
 */
const NO_OP_ANCHOR = /<a\s(?:[^>]*\s)?href=(["'])#\1(?:\s[^>]*)?>([\s\S]*?)<\/a>/gi
const unwrapNoOpAnchors = (md: string): string => md.replace(NO_OP_ANCHOR, "$2")

/**
 * Keep the href on a markdown link that points at a worktree file.
 *
 * Streamdown's hardening drops a RELATIVE href outright and renders the link as
 * an inert `<button>` — so by the time any component sees it, the path is gone
 * and there is nothing left to intercept. `urlTransform` is the one seam that
 * runs before that, so this is where a link like `./docs/spec.md` has to be
 * rescued.
 *
 * Everything else is handed straight to `defaultUrlTransform`. That is the point:
 * the ONLY urls this waves through are ones already proven to name a file in
 * this session's worktree, so `javascript:` and friends are still hardened
 * exactly as before.
 */
const useAssetUrlTransform = (): UrlTransform => {
  const ctx = useOpenAsset()
  return useMemo<UrlTransform>(() => {
    if (!ctx) return defaultUrlTransform
    return (url, key, node) =>
      key === "href" && resolveOpenablePath(url, ctx.knownFiles) !== null
        ? url
        : defaultUrlTransform(url, key, node)
  }, [ctx])
}

/**
 * Renders agent markdown as prose via `streamdown` — headings, bold, lists,
 * inline/blocked code, tables, etc. `parseIncompleteMarkdown` makes it safe to
 * render a half-streamed message (unclosed fences/bold don't flash broken).
 * Scoped to our One Dark tokens via the `.sb-md` wrapper (see globals.css).
 *
 * A ```diff fenced block is rendered with our own `DiffPeek` (the same red/green
 * line view used elsewhere) instead of Streamdown's generic code-block chrome.
 */
export function Markdown({ children, className }: { children: string; className?: string }) {
  const source = useMemo(() => unwrapNoOpAnchors(children), [children])
  const urlTransform = useAssetUrlTransform()
  return (
    <div
      className={cn(
        "sb-md text-[calc(14.5px*var(--sb-font-scale,1))] leading-[1.65] text-text-body",
        className
      )}
    >
      <Streamdown
        parseIncompleteMarkdown
        plugins={PLUGINS}
        allowedTags={ALLOWED_TAGS}
        shikiTheme={["one-dark-pro", "one-dark-pro"]}
        urlTransform={urlTransform}
        components={COMPONENTS}
      >
        {source}
      </Streamdown>
    </div>
  )
}
