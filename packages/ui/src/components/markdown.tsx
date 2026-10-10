import { createContext, isValidElement, useContext, useMemo, type MouseEvent, type ReactNode } from "react"
import { Streamdown, defaultRehypePlugins, defaultRemarkPlugins, defaultUrlTransform, type MathPlugin, type UrlTransform } from "streamdown"
import rehypeKatex from "rehype-katex"
import rehypeSlug from "rehype-slug"
import remarkBreaks from "remark-breaks"
import remarkGemoji from "remark-gemoji"
import remarkGithub, { defaultBuildUrl } from "remark-github"
import { remarkAlert } from "remark-github-blockquote-alert"
import remarkMath from "remark-math"
import { cn } from "../lib/cn.js"
import { DiffPeek } from "./diff-peek.js"
import { CodeBlock } from "./beui/code-block.js"
import { FileIcon } from "./file-icon.js"
import { isAgentCodeLanguage } from "./beui/agent-code.js"
import { HtmlPreview } from "./html-preview.js"
import { MermaidDiagram } from "./mermaid-diagram.js"
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

type Pluggable = (typeof defaultRehypePlugins)[string]
type PluginFn = Extract<Pluggable, (...args: never[]) => unknown>
type SanitizeAttribute = string | [string, ...Array<string | RegExp>]
interface SanitizeSchema { tagNames?: string[]; attributes?: Record<string, SanitizeAttribute[]> }

/**
 * GitHub-flavoured rehype pipeline: Streamdown's raw → sanitize → harden, plus
 * heading anchors.
 *
 * Streamdown only merges its `allowedTags` prop into the sanitize schema when
 * `rehypePlugins` IS its default array, so adding any rehype plugin means
 * building that schema here. The defaults' own entries are reused by identity:
 * Streamdown checks for its `rehype-raw` entry and, if missing, rewrites raw
 * HTML into literal text.
 *
 * Extra tags: Greptile's `<details>` and `<picture><source>` badges, and the
 * `<svg><path>` octicons GitHub alerts render with. An attribute entry REPLACES
 * the default list for that tag, so `div`/`p` spread their defaults back in.
 *
 * `rehype-slug` runs AFTER sanitize with GitHub's `user-content-` prefix:
 * sanitize clobbers ids with that prefix, and `MarkdownAnchor` resolves `#x`
 * against it the same way github.com does.
 */
const [sanitizePlugin, baseSchema] = defaultRehypePlugins.sanitize as [PluginFn, SanitizeSchema]
const baseAttributes = baseSchema.attributes ?? {}
const REHYPE_PLUGINS: Pluggable[] = [
  defaultRehypePlugins.raw!,
  [sanitizePlugin, {
    ...baseSchema,
    tagNames: [...(baseSchema.tagNames ?? []), "details", "summary", "picture", "source", "svg", "path"],
    attributes: {
      ...baseAttributes,
      // `srcSet` is the one attribute here that the global `"*"` list lacks.
      source: ["srcSet", "srcset", "type"],
      svg: [["className", "octicon"], "viewBox", "width", "height", "ariaHidden"],
      path: ["d"],
      div: [...(baseAttributes.div ?? []), ["className", /^markdown-alert(-\w+)?$/]],
      p: [...(baseAttributes.p ?? []), ["className", "markdown-alert-title"]],
    },
  }],
  [rehypeSlug, { prefix: "user-content-" }],
  defaultRehypePlugins.harden!,
]

/**
 * remark-github needs a repository and throws without one. Agent transcripts
 * have none, so a sentinel stands in and bare `#123` / SHAs stay unlinked while
 * `@mentions` and fully qualified `owner/repo#9` refs still link.
 */
const NO_REPOSITORY = "jingler-none/jingler-none"
const remarkPluginsCache = new Map<string, Pluggable[]>()
const remarkPluginsFor = (repository = NO_REPOSITORY): Pluggable[] => {
  let plugins = remarkPluginsCache.get(repository)
  if (!plugins) {
    plugins = [
      ...Object.values(defaultRemarkPlugins),
      remarkBreaks,
      remarkGemoji,
      remarkAlert,
      [remarkGithub, {
        repository,
        buildUrl: (values: Parameters<typeof defaultBuildUrl>[0]) =>
          values.type !== "mention" && `${values.user}/${values.project}` === NO_REPOSITORY ? false : defaultBuildUrl(values),
      }],
    ]
    remarkPluginsCache.set(repository, plugins)
  }
  return plugins
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
const MarkdownStreaming = createContext(false)

function MarkdownPre({ children }: { children?: ReactNode }) {
  const streaming = useContext(MarkdownStreaming)
  const code = isValidElement<{ className?: string; children?: unknown }>(children) ? children : null
  const lang = /language-([\w+#-]+)/.exec(code?.props.className ?? "")?.[1]?.toLowerCase()
  const text = String(code?.props.children ?? "").replace(/\n$/, "")
  if (lang === "diff") {
    return (
      <div className="my-3 overflow-hidden rounded-md border border-line px-3 pb-1 pt-1.5">
        <DiffPeek preview={text} />
      </div>
    )
  }
  if (lang === "html") {
    // Opt-in per-block: defaults to the raw Code view (plain text); the operator
    // can switch to a sandboxed Preview. See HtmlPreview.
    return <HtmlPreview code={text} />
  }
  if (lang === "mermaid") {
    // A ```mermaid fence renders as an actual (themed, sandboxed) diagram.
    return <MermaidDiagram source={text} />
  }
  const language = lang && isAgentCodeLanguage(lang) ? lang : "text"
  if (text.split("\n").length > 200) return <InsideFence.Provider value={true}><pre>{children}</pre></InsideFence.Provider>
  const iconPath = `code.${language === "typescript" ? "ts" : language === "bash" ? "sh" : language}`
  return <CodeBlock code={text} language={language} fileIcon={<FileIcon path={iconPath} size={14} />} status={streaming ? "streaming" : "complete"} />
}

const handleLinkClick = (open?: () => void) => (event: MouseEvent<HTMLAnchorElement>) => {
  const selection = window.getSelection()
  if (event.detail !== 0 && selection?.toString() && selection.getRangeAt(0).intersectsNode(event.currentTarget)) {
    event.preventDefault()
    return
  }
  if (open) {
    event.preventDefault()
    open()
  }
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
    <a href={text} draggable={false} onClick={handleLinkClick(open)} onAuxClick={event => event.preventDefault()} title={`Open ${text}`} className="sb-md-path">
      <code {...rest}>{children}</code>
    </a>
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
  if (href?.startsWith("#")) {
    // Sanitize prefixes every id with `user-content-` (footnotes get it twice, as
    // on github.com), so try the fragment with and without that prefix.
    const jump = (event: MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault()
      // Malformed escapes (`#a%`) make decodeURIComponent throw; use the raw fragment then.
      const raw = href.slice(1)
      const fragment = (() => { try { return decodeURIComponent(raw) } catch { return raw } })()
      const root = event.currentTarget.closest(".sb-md")
      const ids = [fragment, `user-content-${fragment}`]
      const target = [...(root?.querySelectorAll("[id]") ?? [])].find((element) => ids.includes(element.id))
      target?.scrollIntoView?.({ block: "start" })
    }
    return <a {...rest} href={href} className={cn("font-medium underline", className)} data-streamdown="link" onClick={jump} target={undefined} rel={undefined}>{children}</a>
  }
  if (open) {
    return (
      <a href={href} draggable={false} onClick={handleLinkClick(open)} onAuxClick={event => event.preventDefault()} title={`Open ${href}`} className="sb-md-path">
        {children}
      </a>
    )
  }
  return (
    <a
      className={cn("wrap-anywhere font-medium underline", className)}
      data-streamdown="link"
      href={href}
      draggable={false}

      onClick={handleLinkClick()}
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
export function Markdown({ children, className, streaming = false, repository }: {
  children: string
  className?: string
  streaming?: boolean
  /** `owner/repo` that bare `#123` and commit SHAs link against, as on GitHub. */
  repository?: string
}) {
  const source = useMemo(() => unwrapNoOpAnchors(children), [children])
  const urlTransform = useAssetUrlTransform()
  return (
    <div
      className={cn(
        "sb-md text-[calc(14.5px*var(--sb-font-scale,1))] leading-[1.65] text-text-body",
        className
      )}
    >
      <MarkdownStreaming.Provider value={streaming}>
      <Streamdown
        parseIncompleteMarkdown
        plugins={PLUGINS}
        remarkPlugins={remarkPluginsFor(repository)}
        rehypePlugins={REHYPE_PLUGINS}
        shikiTheme={["one-dark-pro", "one-dark-pro"]}
        urlTransform={urlTransform}
        components={COMPONENTS}
      >
        {source}
      </Streamdown>
      </MarkdownStreaming.Provider>
    </div>
  )
}
