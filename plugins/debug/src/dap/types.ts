/* oxlint-disable anti-slop/no-unsafe-dictionary-type -- DAP custom requests intentionally carry adapter-defined JSON fields. */
import type { ChildProcessWithoutNullStreams } from "node:child_process"

export type JsonObject = Record<string, unknown>

export interface DapAdapterConfig {
  readonly command: string
  readonly args: readonly string[]
  readonly languages: readonly string[]
  readonly fileTypes: readonly string[]
  readonly rootMarkers: readonly string[]
  readonly launchDefaults: JsonObject
  readonly attachDefaults: JsonObject
  readonly acceptsDirectoryProgram: boolean
  readonly connectMode?: "stdio" | "socket" | "tcp"
}

export interface DapResolvedAdapter extends DapAdapterConfig {
  readonly name: string
  readonly commandPath: string
}

export interface DapMessage { readonly seq: number; readonly type: string }
export interface DapResponse extends DapMessage {
  readonly type: "response"
  readonly request_seq: number
  readonly success: boolean
  readonly command: string
  readonly message?: string
  readonly body?: JsonObject
}
export interface DapEvent extends DapMessage {
  readonly type: "event"
  readonly event: string
  readonly body?: JsonObject
}
export interface DapRequest extends DapMessage {
  readonly type: "request"
  readonly command: string
  readonly arguments?: JsonObject
}

export interface DapSource { readonly name?: string; readonly path?: string; readonly sourceReference?: number }
export interface DapStackFrame {
  readonly id: number
  readonly name: string
  readonly source?: DapSource
  readonly line: number
  readonly column: number
  readonly instructionPointerReference?: string
}
export interface DapThread { readonly id: number; readonly name: string }
export interface DapScope {
  readonly name: string
  readonly variablesReference: number
  readonly expensive: boolean
  readonly presentationHint?: string
}
export interface DapVariable {
  readonly name: string
  readonly value: string
  readonly type?: string
  readonly variablesReference: number
  readonly evaluateName?: string
  readonly memoryReference?: string
}
export interface DapBreakpoint { readonly id?: number; readonly verified?: boolean; readonly line?: number; readonly message?: string }
export interface DapCapabilities extends JsonObject {
  readonly supportsConfigurationDoneRequest?: boolean
  readonly supportsTerminateRequest?: boolean
  readonly supportsFunctionBreakpoints?: boolean
  readonly supportsInstructionBreakpoints?: boolean
  readonly supportsDataBreakpoints?: boolean
  readonly supportsDisassembleRequest?: boolean
  readonly supportsReadMemoryRequest?: boolean
  readonly supportsWriteMemoryRequest?: boolean
  readonly supportsModulesRequest?: boolean
  readonly supportsLoadedSourcesRequest?: boolean
}

export type DapStatus = "starting" | "running" | "stopped" | "terminated" | "error"
export interface DapSessionSnapshot {
  readonly id: string
  readonly adapter: string
  readonly cwd: string
  readonly program?: string
  readonly status: DapStatus
  readonly stopReason?: string
  readonly stopSequence?: number
  readonly threadId?: number
  readonly frame?: DapStackFrame
  readonly threads: readonly DapThread[]
  readonly stackFrames: readonly DapStackFrame[]
  readonly breakpoints: Readonly<Record<string, readonly DapBreakpoint[]>>
  readonly output: string
  readonly exitCode?: number
}

export interface DapTransport {
  readonly process: ChildProcessWithoutNullStreams
  write(message: string): Promise<void>
  onData(listener: (chunk: Buffer) => void): void
  dispose(): Promise<void>
}
