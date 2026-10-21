import type { Message, PrEventPart } from "./conversation.js"

/** The layer directly below `number` in an ordered (bottom-first) stack, if any. */
export const stackedOnPr = (prs: ReadonlyArray<{ readonly number: number }>, number: number): number | undefined => {
  const at = prs.findIndex((pr) => pr.number === number)
  return at > 0 ? prs[at - 1]!.number : undefined
}

/** Stable id: one card per (kind, PR), which is what makes recording idempotent. */
export const prEventMessageId = (kind: PrEventPart["kind"], number: number): string => `a_pr_${kind}_${number}`

/** Pure mapping from a PR lifecycle event to the transcript message that records it. */
export const prEventMessage = (input: {
  readonly kind: PrEventPart["kind"]
  readonly number: number
  readonly prs: ReadonlyArray<{ readonly number: number }>
  readonly now: string
}): Message => {
  const stackedOn = input.kind === "opened" ? stackedOnPr(input.prs, input.number) : undefined
  return {
    id: prEventMessageId(input.kind, input.number),
    role: "assistant",
    parts: [{ _tag: "PrEvent", kind: input.kind, number: input.number, ...(stackedOn === undefined ? {} : { stackedOn }) }],
    streaming: false,
    createdAt: input.now
  }
}
