import { Markdown } from "../components/markdown.js"
import { StreamingResponse } from "./beui/messages.js"

/**
 * Markdown-preserving streaming text. The transport already appends tokens, so
 * this component never replays content on a timer; it only marks the live tail
 * with the reference-inspired caret.
 */
export function StreamingText({
  text,
  streaming = true,
  className
}: {
  text: string
  streaming?: boolean
  className?: string
}) {
  return (
    <StreamingResponse streaming={streaming} className={className}>
      <Markdown>
        {text}
      </Markdown>
    </StreamingResponse>
  )
}
