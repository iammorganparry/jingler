import { realpath } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import type { Message as PiMessage } from "@earendil-works/pi-ai"
import { SessionManager } from "@earendil-works/pi-coding-agent"
import type { ContentPart, Message } from "@jingler/core"

const containedBy = (file: string, root: string): boolean => {
  const path = relative(root, file)
  return path === "" || (!path.startsWith("..") && !isAbsolute(path))
}

const textOf = (message: PiMessage): string => {
  if (message.role === "user") {
    return typeof message.content === "string"
      ? message.content
      : message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
  }
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

const partsOf = (message: PiMessage): ReadonlyArray<ContentPart> => {
  if (message.role === "user") {
    const content = typeof message.content === "string"
      ? [{ type: "text" as const, text: message.content }]
      : message.content
    return content.map((part): ContentPart =>
      part.type === "text"
        ? { _tag: "Text", text: part.text }
        : {
            _tag: "Image",
            attachment: {
              id: `child-image-${message.timestamp}`,
              name: "Child session image",
              mediaType: part.mimeType,
              data: part.data
            }
          }
    )
  }
  if (message.role === "toolResult") {
    const text = textOf(message)
    return [{
      _tag: "Text",
      text: `${message.isError ? "Tool error" : "Tool result"} (${message.toolName})${text ? `\n${text}` : ""}`
    }]
  }
  return message.content.map((part): ContentPart => {
    if (part.type === "text") return { _tag: "Text", text: part.text }
    if (part.type === "thinking") {
      return { _tag: "Thinking", text: part.thinking, seconds: null, streaming: false }
    }
    return {
      _tag: "Tool",
      tool: {
        id: part.id,
        name: part.name,
        target: null,
        status: "success",
        meta: null,
        diff: null,
        preview: null
      }
    }
  })
}

export const piMessagesToJingler = (
  messages: ReadonlyArray<PiMessage>
): ReadonlyArray<Message> =>
  messages.map((message, index) => ({
    id: `child-${message.timestamp}-${index}`,
    role: message.role === "user" ? "user" : "assistant",
    parts: partsOf(message),
    streaming: false,
    createdAt: new Date(message.timestamp).toISOString()
  }))

export const readPiSubagentTranscript = async (input: {
  readonly sessionFile: string
  readonly trustedRoots: ReadonlyArray<string>
}): Promise<ReadonlyArray<Message>> => {
  const file = await realpath(resolve(input.sessionFile))
  const roots = await Promise.all(
    input.trustedRoots.map((root) => realpath(resolve(root)))
  )
  if (!roots.some((root) => containedBy(file, root))) {
    throw new Error("Child session file is outside the trusted pi-subagents roots")
  }
  const session = SessionManager.open(file, dirname(file))
  const messages = session.buildSessionContext().messages.filter(
    (message): message is PiMessage =>
      message.role === "user" ||
      message.role === "assistant" ||
      message.role === "toolResult"
  )
  return piMessagesToJingler(messages)
}
