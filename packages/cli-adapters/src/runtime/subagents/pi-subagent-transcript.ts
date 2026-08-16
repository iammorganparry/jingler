import { realpath } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import type { Message as PiMessage } from "@earendil-works/pi-ai"
import { SessionManager } from "@earendil-works/pi-coding-agent"
import type { ContentPart, Message, ToolCall } from "@jingler/core"

const containedBy = (file: string, root: string): boolean => {
  const path = relative(root, file)
  return path === "" || (!path.startsWith("..") && !isAbsolute(path))
}

const recordOf = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null

const stringField = (
  value: Readonly<Record<string, unknown>>,
  key: string
): string | null => typeof value[key] === "string" ? value[key] : null

const toolTarget = (argumentsValue: unknown): string | null => {
  const args = recordOf(argumentsValue)
  if (args === null) return null
  for (const key of ["path", "command", "url", "selector", "expression", "query"]) {
    const value = stringField(args, key)
    if (value !== null) return value
  }
  const from = stringField(args, "from")
  const to = stringField(args, "to")
  return from !== null && to !== null ? `${from} → ${to}` : null
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

const toolResult = (
  message: Extract<PiMessage, { readonly role: "toolResult" }>
): Pick<ToolCall, "status" | "meta" | "output"> => {
  const raw = textOf(message)
  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    decoded = null
  }
  const result = recordOf(decoded)
  const stdout = result === null ? null : stringField(result, "stdout")
  const stderr = result === null ? null : stringField(result, "stderr")
  const text = result === null ? null : stringField(result, "text")
  const output = stdout !== null || stderr !== null
    ? [stdout, stderr].filter((value): value is string => Boolean(value)).join("\n")
    : text ?? (result === null ? raw : JSON.stringify(result, null, 2))
  const exitCode = result?.exitCode
  return {
    status: message.isError ? "error" : "success",
    meta: typeof exitCode === "number" ? `exit ${exitCode}` : null,
    output
  }
}

const partsOf = (
  message: Exclude<PiMessage, { readonly role: "toolResult" }>
): ReadonlyArray<ContentPart> => {
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
        target: toolTarget(part.arguments),
        status: "running",
        meta: null,
        diff: null,
        preview: null
      }
    }
  })
}

const settleToolResult = (
  messages: Array<Message>,
  result: Extract<PiMessage, { readonly role: "toolResult" }>
): boolean => {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (!message.parts.some(
      (part) => part._tag === "Tool" && part.tool.id === result.toolCallId
    )) continue
    const settled = toolResult(result)
    messages[index] = {
      ...message,
      parts: message.parts.map((part): ContentPart =>
        part._tag === "Tool" && part.tool.id === result.toolCallId
          ? { _tag: "Tool", tool: { ...part.tool, ...settled } }
          : part
      )
    }
    return true
  }
  return false
}

export const piMessagesToJingler = (
  messages: ReadonlyArray<PiMessage>
): ReadonlyArray<Message> => {
  const projected: Array<Message> = []
  for (const [index, message] of messages.entries()) {
    if (message.role === "toolResult") {
      if (!settleToolResult(projected, message)) {
        const text = textOf(message)
        projected.push({
          id: `child-${message.timestamp}-${index}`,
          role: "assistant",
          parts: [{
            _tag: "Text",
            text: `${message.isError ? "Tool error" : "Tool result"} (${message.toolName})${text ? `\n${text}` : ""}`
          }],
          streaming: false,
          createdAt: new Date(message.timestamp).toISOString()
        })
      }
      continue
    }
    projected.push({
      id: `child-${message.timestamp}-${index}`,
      role: message.role === "user" ? "user" : "assistant",
      parts: partsOf(message),
      streaming: false,
      createdAt: new Date(message.timestamp).toISOString()
    })
  }
  return projected
}

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
