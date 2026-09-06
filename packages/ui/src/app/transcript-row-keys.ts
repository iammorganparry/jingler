export interface TranscriptRowKeys<Message> {
  messages: ReadonlyArray<Message>
  keys: ReadonlyArray<string>
  next: number
}

/** Reuse row identities during streaming and preserve the existing side of a history splice. */
export function updateTranscriptRowKeys<Message>(
  previous: TranscriptRowKeys<Message>,
  messages: ReadonlyArray<Message>
): TranscriptRowKeys<Message> {
  if (previous.messages === messages) return previous
  const allocate = (count: number) =>
    Array.from({ length: count }, () => `transcript-row-${previous.next++}`)
  let keys = previous.keys
  const added = messages.length - previous.messages.length
  if (added === 0) return { messages, keys, next: previous.next }
  if (added > 0 && messages[added] === previous.messages[0]) {
    keys = [...allocate(added), ...previous.keys]
  } else if (added > 0 && messages[0] === previous.messages[0]) {
    keys = [...previous.keys, ...allocate(added)]
  } else {
    keys = allocate(messages.length)
  }
  return { messages, keys, next: previous.next }
}
