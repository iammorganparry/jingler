import { open, realpath, stat } from "node:fs/promises"
import { basename, dirname, isAbsolute, relative, resolve } from "node:path"
import type { Message as PiMessage } from "@earendil-works/pi-ai"
import { SessionManager } from "@earendil-works/pi-coding-agent"
import type { ContentPart, Message, ToolCall } from "@jingler/core"
import {
  Context,
  Effect,
  Layer,
  SynchronizedRef
} from "effect"

export const piSubagentTrustedSessionRoots = (
  parentSessionFile: string
): ReadonlyArray<string> => {
  const sessionDirectory = dirname(resolve(parentSessionFile))
  return [
    sessionDirectory,
    resolve(sessionDirectory, basename(parentSessionFile, ".jsonl"))
  ]
}

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

export const appendPiMessagesToJingler = (
  previous: ReadonlyArray<Message>,
  messages: ReadonlyArray<PiMessage>,
  indexOffset = 0
): ReadonlyArray<Message> => {
  const projected: Array<Message> = [...previous]
  for (const [index, message] of messages.entries()) {
    const messageIndex = indexOffset + index
    if (message.role === "toolResult") {
      appendStandaloneToolResult(projected, message, messageIndex)
      continue
    }
    projected.push({
      id: `child-${message.timestamp}-${messageIndex}`,
      role: message.role === "user" ? "user" : "assistant",
      parts: partsOf(message),
      streaming: false,
      createdAt: new Date(message.timestamp).toISOString()
    })
  }
  return projected
}

export const piMessagesToJingler = (
  messages: ReadonlyArray<PiMessage>
): ReadonlyArray<Message> => appendPiMessagesToJingler([], messages)

export interface PiSubagentTranscriptInput {
  readonly sessionFile: string
  readonly trustedRoots: ReadonlyArray<string>
}

interface TranscriptCursor {
  readonly file: string
  readonly inode: number
  readonly offset: number
  readonly modifiedAt: number
  readonly leafId: string | null
  readonly messageCount: number
  readonly messages: ReadonlyArray<Message>
}

export interface PiSubagentTranscriptReaderShape {
  readonly read: (
    input: PiSubagentTranscriptInput
  ) => Effect.Effect<ReadonlyArray<Message>, Error>
  readonly clear: Effect.Effect<void>
}

export class PiSubagentTranscriptReader extends Context.Tag(
  "@jingler/PiSubagentTranscriptReader"
)<PiSubagentTranscriptReader, PiSubagentTranscriptReaderShape>() {}

const isPiMessage = (value: unknown): value is PiMessage => {
  const record = recordOf(value)
  if (!record || typeof record.timestamp !== "number") return false
  if (record.role === "user") {
    return typeof record.content === "string" || Array.isArray(record.content)
  }
  if (record.role === "assistant") return Array.isArray(record.content)
  return record.role === "toolResult" &&
    Array.isArray(record.content) &&
    typeof record.toolCallId === "string" &&
    typeof record.toolName === "string" &&
    typeof record.isError === "boolean"
}

const sessionContext = (file: string): {
  readonly messages: ReadonlyArray<PiMessage>
  readonly leafId: string | null
} => {
  const session = SessionManager.open(file, dirname(file))
  return {
    messages: session.buildSessionContext().messages.filter(isPiMessage),
    leafId: session.getLeafId()
  }
}

const fullCursor = async (file: string): Promise<TranscriptCursor> => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await stat(file)
    const context = sessionContext(file)
    const after = await stat(file)
    if (before.size === after.size && before.ino === after.ino) {
      return {
        file,
        inode: after.ino,
        offset: after.size,
        modifiedAt: after.mtimeMs,
        leafId: context.leafId,
        messageCount: context.messages.length,
        messages: piMessagesToJingler(context.messages)
      }
    }
  }
  throw new Error("Child session changed while its transcript cursor was initialized")
}

const appendedMessages = async (
  cursor: TranscriptCursor,
  size: number
): Promise<{
  readonly messages: ReadonlyArray<PiMessage>
  readonly consumed: number
  readonly leafId: string | null
  readonly requiresRebuild: boolean
}> => {
  const handle = await open(cursor.file, "r")
  try {
    const bytes = Buffer.alloc(size - cursor.offset)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, cursor.offset)
    const read = bytes.subarray(0, bytesRead)
    const lastNewline = read.lastIndexOf(0x0a)
    if (lastNewline < 0) {
      return {
        messages: [],
        consumed: 0,
        leafId: cursor.leafId,
        requiresRebuild: false
      }
    }
    const messages: PiMessage[] = []
    let leafId = cursor.leafId
    for (const line of read.subarray(0, lastNewline).toString("utf8").split("\n")) {
      if (!line.trim()) continue
      const entry = recordOf(JSON.parse(line))
      if (
        entry === null ||
        typeof entry.id !== "string" ||
        (entry.parentId !== null && typeof entry.parentId !== "string") ||
        entry.parentId !== leafId ||
        entry.type !== "message" ||
        !isPiMessage(entry.message)
      ) {
        return {
          messages: [],
          consumed: lastNewline + 1,
          leafId,
          requiresRebuild: true
        }
      }
      messages.push(entry.message)
      leafId = entry.id
    }
    return {
      messages,
      consumed: lastNewline + 1,
      leafId,
      requiresRebuild: false
    }
  } finally {
    await handle.close()
  }
}

const trustedFile = async (input: PiSubagentTranscriptInput): Promise<string> => {
  const file = await realpath(resolve(input.sessionFile))
  const roots = (await Promise.all(
    input.trustedRoots.map((root) => realpath(resolve(root)).catch(() => null))
  )).filter((root): root is string => root !== null)
  if (!roots.some((root) => containedBy(file, root))) {
    throw new Error("Child session file is outside the trusted pi-subagents roots")
  }
  return file
}

export const makePiSubagentTranscriptReader = (): Effect.Effect<
  PiSubagentTranscriptReaderShape
> => Effect.gen(function* () {
  const cursors = yield* SynchronizedRef.make<ReadonlyMap<string, TranscriptCursor>>(
    new Map()
  )
  return {
    read: (input) => Effect.tryPromise({
      try: () => trustedFile(input),
      catch: (cause) => cause instanceof Error
        ? cause
        : new Error("Could not resolve pi-subagents transcript")
    }).pipe(
      Effect.flatMap((file) => SynchronizedRef.modifyEffect(cursors, (current) =>
        Effect.tryPromise({
          try: async () => {
            const cached = current.get(file)
                  return await readTranscriptDelta(file, cached, current)
                },
                catch: (cause) =>
                  cause instanceof Error
                    ? cause
                    : new Error("Could not read pi-subagents transcript")
              })
            )
          )
        ),
      clear: SynchronizedRef.set(cursors, new Map())
    }
  })

export const PiSubagentTranscriptReaderLive = Layer.effect(
  PiSubagentTranscriptReader,
  makePiSubagentTranscriptReader()
)

export const readPiSubagentTranscript = (
  input: PiSubagentTranscriptInput
): Effect.Effect<ReadonlyArray<Message>, Error> => Effect.flatMap(
  makePiSubagentTranscriptReader(),
  (reader) => reader.read(input)
)

function appendStandaloneToolResult(
  projected: Array<Message>,
  message: Extract<PiMessage, { role: "toolResult" }>,
  messageIndex: number
) {
  if (!settleToolResult(projected, message)) {
    const text = textOf(message)
    projected.push({
      id: `child-${message.timestamp}-${messageIndex}`,
      role: "assistant",
      parts: [
        {
          _tag: "Text",
          text: `${message.isError ? "Tool error" : "Tool result"} (${message.toolName})${text ? `\n${text}` : ""}`
        }
      ],
      streaming: false,
      createdAt: new Date(message.timestamp).toISOString()
    })
  }
}

async function readTranscriptDelta(
  file: string,
  cached: TranscriptCursor | undefined,
  current: ReadonlyMap<string, TranscriptCursor>
) {
  const metadata = await stat(file)
            let next: TranscriptCursor
            if (
              !cached ||
              cached.inode !== metadata.ino ||
              metadata.size < cached.offset ||
              (metadata.size === cached.offset && metadata.mtimeMs !== cached.modifiedAt)
            ) {
              next = await fullCursor(file)
            } else if (metadata.size === cached.offset) {
              next = cached
            } else {
              const appended = await appendedMessages(cached, metadata.size)
              if (appended.requiresRebuild) {
                next = await fullCursor(file)
              } else {
                const projected = appendPiMessagesToJingler(
                  cached.messages,
                  appended.messages,
                  cached.messageCount
                )
                next = {
                  ...cached,
                  offset: cached.offset + appended.consumed,
                  modifiedAt: metadata.mtimeMs,
                  leafId: appended.leafId,
                  messageCount: cached.messageCount + appended.messages.length,
                  messages: projected
                }
              }
            }
            const updated = new Map(current)
            updated.set(file, next)
            return [next.messages, updated] as const
          }
