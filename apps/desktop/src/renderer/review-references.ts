/**
 * Code references for review comments sent to the agent.
 *
 * A comment names a new-side line range; the agent needs the code on those
 * lines too, not just the numbers. The excerpt is captured from the diff the
 * comment was written against — the same `<repository-code-references>`
 * envelope the composer's "Add to chat" references use.
 */
import { captureDiffCodeReference } from "./file-diff-context.js"
import { serializeCodeReferences, type CodeReference } from "./code-reference.js"

export interface ReviewCommentLocation {
  readonly path: string
  readonly line: number
  readonly endLine: number | null
}

export const reviewCommentReference = (
  patch: string,
  comment: ReviewCommentLocation
): CodeReference | null =>
  captureDiffCodeReference(patch, {
    path: comment.path,
    side: "new",
    endSide: "new",
    startLine: comment.line,
    endLine: comment.endLine ?? comment.line
  })

/** The agent context for a batch of comments; ranges the diff can't supply are skipped. */
export const reviewCommentsContext = (
  patchFor: (path: string) => string,
  comments: ReadonlyArray<ReviewCommentLocation>
): string =>
  serializeCodeReferences(
    comments.flatMap((comment) => {
      const reference = reviewCommentReference(patchFor(comment.path), comment)
      return reference === null ? [] : [reference]
    })
  )
