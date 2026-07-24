import { createWriteStream, mkdirSync, type WriteStream } from "node:fs"
import { join } from "node:path"

const STDERR_CHUNK_LIMIT = 4_096
const STDERR_LINE_LIMIT = 16_384

export interface CodexAppServerDiagnosticContext {
  readonly sessionId: string
  readonly model: string | null
  readonly reasoningEffort: string | null
}

type CodexAppServerDiagnosticValue = boolean | number | string | null | undefined

/**
 * Event-specific fields remain flat for grep-friendly JSONL, but envelope keys
 * belong exclusively to the recorder. The `never` properties turn accidental
 * collisions into type errors instead of silently replacing caller data.
 */
export type CodexAppServerDiagnosticFields = Readonly<
  Record<string, CodexAppServerDiagnosticValue>
> & {
  readonly timestamp?: never
  readonly event?: never
  readonly sessionId?: never
  readonly model?: never
  readonly reasoningEffort?: never
}

export interface CodexAppServerDiagnostics {
  readonly path: string
  readonly record: (event: string, fields?: CodexAppServerDiagnosticFields) => void
  readonly close: () => void
}

export interface CodexStderrRecorder {
  readonly append: (chunk: Buffer | string) => void
  readonly flush: () => void
}

const diagnosticFileName = (now: Date): string =>
  `codex-app-server-${now.toISOString().slice(0, 10)}.jsonl`

/**
 * Codex stderr can contain bearer credentials and MCP session ids. Diagnostics
 * are useful only if they are safe to attach to an issue, so redact before any
 * text crosses the file boundary.
 */
export const redactCodexDiagnosticText = (value: string): string =>
  value
    .replace(
      /\b(session_id|authorization|api[_-]?key|access[_-]?token|refresh[_-]?token)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|Bearer\s+\S+|\S+)/gi,
      // biome-ignore lint/security/noSecrets: This literal is the replacement marker, not a credential.
      '$1$2"[REDACTED]"'
    )
    .replace(
      /\b(?:Bearer\s+)?eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
      "[REDACTED_TOKEN]"
    )
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_TOKEN]")

export const boundedCodexStderr = (value: string): string => {
  const redacted = redactCodexDiagnosticText(value)
  return redacted.length <= STDERR_CHUNK_LIMIT
    ? redacted
    : redacted.slice(redacted.length - STDERR_CHUNK_LIMIT)
}

/**
 * Join arbitrary stream chunks before redaction so a credential split across
 * two `data` events cannot evade the token patterns. Lines are bounded before
 * persistence; an oversized line is omitted rather than sliced into a fragment
 * that may no longer contain the credential's recognizable prefix.
 */
export const createCodexStderrRecorder = (
  diagnostics: CodexAppServerDiagnostics | null | undefined
): CodexStderrRecorder => {
  let pending = ""
  let discardingOversizedLine = false
  let closed = false

  const completeLine = (fragment: string): void => {
    if (discardingOversizedLine) {
      discardingOversizedLine = false
      return
    }
    if (pending.length + fragment.length > STDERR_LINE_LIMIT) {
      pending = ""
      diagnostics?.record("process.stderr", {
        text: `[stderr line omitted: exceeded ${STDERR_LINE_LIMIT} characters]`,
        truncated: true
      })
      return
    }
    pending += fragment
    if (pending.length > 0) {
      diagnostics?.record("process.stderr", { text: boundedCodexStderr(pending) })
      pending = ""
    }
  }

  const appendFragment = (fragment: string): void => {
    if (discardingOversizedLine) return
    if (pending.length + fragment.length > STDERR_LINE_LIMIT) {
      pending = ""
      discardingOversizedLine = true
      diagnostics?.record("process.stderr", {
        text: `[stderr line omitted: exceeded ${STDERR_LINE_LIMIT} characters]`,
        truncated: true
      })
      return
    }
    pending += fragment
  }

  return {
    append: (chunk) => {
      if (closed) return
      const text = chunk.toString()
      let start = 0
      for (let index = 0; index < text.length; index += 1) {
        if (text[index] !== "\n" && text[index] !== "\r") continue
        completeLine(text.slice(start, index))
        start = index + 1
      }
      appendFragment(text.slice(start))
    },
    flush: () => {
      if (closed) return
      closed = true
      if (!discardingOversizedLine && pending.length > 0) {
        diagnostics?.record("process.stderr", { text: boundedCodexStderr(pending) })
      }
      pending = ""
      discardingOversizedLine = false
    }
  }
}

const writeLine = ({
  stream,
  context,
  event,
  fields,
  now
}: {
  readonly stream: WriteStream
  readonly context: CodexAppServerDiagnosticContext
  readonly event: string
  readonly fields: CodexAppServerDiagnosticFields
  readonly now: () => Date
}): void => {
  stream.write(
    `${JSON.stringify({
      ...fields,
      timestamp: now().toISOString(),
      event,
      ...context
    })}\n`
  )
}

/**
 * A best-effort JSONL lifecycle trace for dev builds. Protocol bodies are
 * excluded; bounded process stderr is credential-redacted before persistence.
 *
 * The Electron entry point enables it by setting
 * `STARBASE_CODEX_DIAGNOSTICS_DIR`; packaged builds leave that unset. Failure to
 * create or write the trace never changes an agent turn's behavior.
 */
export const createCodexAppServerDiagnostics = (
  directory: string | undefined,
  context: CodexAppServerDiagnosticContext,
  now: () => Date = () => new Date()
): CodexAppServerDiagnostics | null => {
  if (!directory) return null
  try {
    mkdirSync(directory, { recursive: true })
    const path = join(directory, diagnosticFileName(now()))
    const stream = createWriteStream(path, { flags: "a" })
    let closed = false
    stream.on("error", () => {
      closed = true
    })
    return {
      path,
      record: (event, fields = {}) => {
        if (closed) return
        try {
          writeLine({ stream, context, event, fields, now })
        } catch {
          closed = true
        }
      },
      close: () => {
        if (closed) return
        closed = true
        stream.end()
      }
    }
  } catch {
    return null
  }
}
