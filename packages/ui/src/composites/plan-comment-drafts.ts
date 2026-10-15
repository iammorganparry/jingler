const draftCounts = new Map<string, number>()

/** Non-empty unsaved texts: the open new-comment box plus every unsent reply. */
export const countUnsavedDrafts = (
  newCommentBody: string,
  replyDrafts: Readonly<Record<string, string>>
): number => [newCommentBody, ...Object.values(replyDrafts)].filter((text) => text.trim().length > 0).length

export const discardCommentsTitle = (count: number): string =>
  `Discard ${count} unsaved ${count === 1 ? "comment" : "comments"}?`

export const planDraftKey = (sessionId: string, chatId: string): string => `${sessionId}:${chatId}`

/** Lets the tab strip ask a mounted Plan review how many drafts it would lose on close. */
export const setPlanDraftCount = (key: string, count: number): void => {
  if (count > 0) draftCounts.set(key, count)
  else draftCounts.delete(key)
}

export const planDraftCount = (key: string): number => draftCounts.get(key) ?? 0
