import type { PrFileChange } from "@jingler/core"
import type { ReviewFileKind } from "./code-review-view-machine.js"

const TEST_PATH = /(^|\/)(__tests__\/|[^/]+\.(?:test|spec)\.[^/]+$)/i
const JSON_PATH = /(?:^|\/)[^/]+\.jsonc?$/i
const DOC_PATH = /(?:^|\/)[^/]+\.(?:md|mdx|txt|rst)$/i
const STYLE_PATH = /(?:^|\/)[^/]+\.(?:css|scss|sass|less|styl)$/i

export const reviewFileKindOf = (path: string): Exclude<ReviewFileKind, "all"> => {
  if (TEST_PATH.test(path)) return "tests"
  if (JSON_PATH.test(path)) return "json"
  if (DOC_PATH.test(path)) return "docs"
  if (STYLE_PATH.test(path)) return "styles"
  return "code"
}

export const filterReviewFiles = (
  files: readonly PrFileChange[],
  options: {
    readonly query: string
    readonly kind: ReviewFileKind
    readonly feedbackPaths?: ReadonlySet<string>
  }
): readonly PrFileChange[] => {
  const query = options.query.trim().toLocaleLowerCase()
  return files.filter((file) => {
    if (query.length > 0 && !file.path.toLocaleLowerCase().includes(query)) return false
    if (options.kind !== "all" && reviewFileKindOf(file.path) !== options.kind) return false
    return options.feedbackPaths === undefined || options.feedbackPaths.has(file.path)
  })
}
