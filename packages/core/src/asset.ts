import { Schema } from "effect"

/**
 * Assets — the files an agent leaves behind in a session's worktree, viewed in
 * the Preview dock. A markdown report, a chart it rendered, a CSV it exported,
 * a PDF it generated.
 *
 * The kind is derived from the extension and NOT from sniffed content, on
 * purpose: the renderer needs to decide whether a path in the transcript is
 * even worth making clickable *before* any IPC round trip, and it can only do
 * that from the string it already has. `extensionToKind` is therefore pure and
 * shared — main uses the same function to pick a read strategy, so the two can
 * never disagree about what a `.md` is.
 */

/** What kind of viewer a file gets. `null` from `extensionToKind` = not viewable. */
export const AssetKind = Schema.Literal("markdown", "code", "text", "csv", "image", "pdf")
export type AssetKind = Schema.Schema.Type<typeof AssetKind>

/**
 * The kinds whose bytes arrive as UTF-8 text. Split out because the payload
 * union below branches on exactly this distinction, and so does the read path.
 */
export const TextAssetKind = Schema.Literal("markdown", "code", "text", "csv")
export type TextAssetKind = Schema.Schema.Type<typeof TextAssetKind>

/** Fields every asset payload carries, whatever its kind. */
const AssetBase = {
  /** Worktree-relative POSIX path — what the tab label and tooltip show. */
  path: Schema.String,
  /**
   * Absolute on-disk path. Used ONLY for "Reveal in Finder" and for the PDF
   * view's `file://` URL, both of which re-validate containment in main. The
   * renderer must never send this back as an authority for a read.
   */
  absolutePath: Schema.String,
  /** Size in bytes, as reported by `stat` at read time. */
  size: Schema.Number
} as const

/**
 * A viewable asset's contents.
 *
 * A discriminated union rather than one struct with optional fields, so it is
 * not representable for a text asset to carry base64 (or an image to carry
 * `text`). The viewer switches on `kind` and TypeScript narrows the payload
 * with it — no `!` and no "this should never happen" branch.
 */
export const AssetPayload = Schema.Union(
  Schema.Struct({
    ...AssetBase,
    kind: TextAssetKind,
    /**
     * Shiki language id for the `code` kind, else null. Resolved from the
     * extension in `extensionToLanguage`; `markdown` and `csv` get their own
     * renderers and never need one.
     */
    language: Schema.NullOr(Schema.String),
    text: Schema.String
  }),
  Schema.Struct({
    ...AssetBase,
    kind: Schema.Literal("image"),
    /** e.g. "image/png". Goes straight into the `data:` URL. */
    mediaType: Schema.String,
    base64: Schema.String
  }),
  /**
   * A PDF ships NO bytes across the RPC boundary. Chromium's own PDF viewer
   * loads it off disk in a `WebContentsView`, which is why this variant is
   * metadata only — sending a 40 MB base64 string to the renderer to then throw
   * it away would be the whole cost of the feature for none of the benefit.
   */
  Schema.Struct({
    ...AssetBase,
    kind: Schema.Literal("pdf")
  })
)
export type AssetPayload = Schema.Schema.Type<typeof AssetPayload>

/**
 * Extension → kind. The single source of truth for "can we show this?".
 *
 * Deliberately a closed allow-list: an unknown extension returns null and the
 * path stays inert text in the transcript. Opening arbitrary binaries as
 * "text" would render a screenful of replacement characters and look like a
 * bug, and guessing from content would mean a round trip per candidate path.
 */
const KIND_BY_EXT: Readonly<Record<string, AssetKind>> = {
  // ── markdown ──
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  // ── tabular ──
  csv: "csv",
  tsv: "csv",
  // ── images ──
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  avif: "image",
  bmp: "image",
  ico: "image",
  svg: "image",
  // ── documents ──
  pdf: "pdf",
  // ── plain text ──
  txt: "text",
  log: "text",
  env: "text",
  // ── code ──
  ts: "code",
  tsx: "code",
  js: "code",
  jsx: "code",
  mjs: "code",
  cjs: "code",
  json: "code",
  jsonc: "code",
  yaml: "code",
  yml: "code",
  toml: "code",
  html: "code",
  css: "code",
  scss: "code",
  sh: "code",
  bash: "code",
  zsh: "code",
  fish: "code",
  py: "code",
  rb: "code",
  go: "code",
  rs: "code",
  java: "code",
  kt: "code",
  swift: "code",
  c: "code",
  h: "code",
  cpp: "code",
  hpp: "code",
  cs: "code",
  php: "code",
  sql: "code",
  graphql: "code",
  gql: "code",
  vue: "code",
  svelte: "code",
  xml: "code",
  ini: "code",
  diff: "code",
  patch: "code"
}

/**
 * Files with no extension that are still worth opening. Matched on the
 * basename, lower-cased. Without this, `Dockerfile` and `Makefile` — two of the
 * things agents most often write — are unopenable.
 */
const KIND_BY_BASENAME: Readonly<Record<string, AssetKind>> = {
  dockerfile: "code",
  makefile: "code",
  justfile: "code",
  procfile: "code",
  gemfile: "code",
  rakefile: "code",
  license: "text",
  readme: "markdown",
  changelog: "markdown",
  notice: "text"
}

/** The basename of a POSIX-ish path, tolerating trailing slashes and Windows separators. */
const basename = (path: string): string => {
  const trimmed = path.replace(/[\\/]+$/, "")
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"))
  return cut < 0 ? trimmed : trimmed.slice(cut + 1)
}

/**
 * The kind we'd render `path` as, or null when we have no viewer for it.
 *
 * Pure and total — safe to call on every inline code span in a transcript,
 * which is exactly what step 06's path detection does.
 */
export const extensionToKind = (path: string): AssetKind | null => {
  const name = basename(path).toLowerCase()
  if (name.length === 0) return null
  // A dotfile like `.gitignore` has no extension in the usual sense: its only
  // dot is the leading one. Treat the whole name as the extension so
  // `.gitignore` / `.env` resolve rather than falling through to the basename
  // table and missing.
  const dot = name.lastIndexOf(".")
  const ext = dot > 0 ? name.slice(dot + 1) : dot === 0 ? name.slice(1) : ""
  return KIND_BY_EXT[ext] ?? KIND_BY_BASENAME[name] ?? (dot === 0 ? "text" : null)
}

/** Shiki language ids that differ from the bare extension. */
const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  mjs: "javascript",
  cjs: "javascript",
  js: "javascript",
  jsx: "jsx",
  ts: "typescript",
  tsx: "tsx",
  yml: "yaml",
  gql: "graphql",
  h: "c",
  hpp: "cpp",
  cs: "csharp",
  rb: "ruby",
  rs: "rust",
  kt: "kotlin",
  py: "python",
  sh: "bash",
  zsh: "bash",
  fish: "bash",
  patch: "diff",
  jsonc: "json"
}

/**
 * The Shiki language id for a `code` asset, or null when we can't name one.
 *
 * Null is a fine outcome — the viewer falls back to unhighlighted monospace,
 * which is strictly better than Shiki throwing on an unknown grammar.
 */
const LANGUAGE_BY_BASENAME: Readonly<Record<string, string>> = {
  dockerfile: "docker",
  makefile: "make",
  justfile: "make"
}

export const extensionToLanguage = (path: string): string | null => {
  const name = basename(path).toLowerCase()
  const dot = name.lastIndexOf(".")
  // Extension-less (`Dockerfile`) and dotfile-only (`.gitignore`) names both
  // have no extension to alias, so they resolve by basename or not at all.
  if (dot <= 0) return LANGUAGE_BY_BASENAME[name] ?? null
  const ext = name.slice(dot + 1)
  return LANGUAGE_ALIASES[ext] ?? ext
}

/**
 * Per-kind size ceilings, in bytes.
 *
 * These are not arbitrary: a text asset is JSON-encoded across IPC and then
 * held as a JS string, and an image is base64'd (a 4/3 blow-up) into a `data:`
 * URL the renderer keeps in memory. A 400 MB log opened this way takes the
 * window with it. Over the cap the viewer shows a "too large" state with a
 * Reveal in Finder escape hatch rather than trying and dying.
 *
 * PDFs are capped far higher because their bytes never cross the boundary —
 * Chromium streams them off disk — so the number here only guards against
 * pointing the viewer at something absurd.
 */
export const ASSET_SIZE_CAP: Readonly<Record<AssetKind, number>> = {
  markdown: 5 * 1024 * 1024,
  code: 5 * 1024 * 1024,
  text: 5 * 1024 * 1024,
  csv: 25 * 1024 * 1024,
  image: 25 * 1024 * 1024,
  pdf: 200 * 1024 * 1024
}
