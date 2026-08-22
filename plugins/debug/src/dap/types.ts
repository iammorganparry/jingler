/* oxlint-disable anti-slop/no-unsafe-dictionary-type -- DAP custom requests intentionally carry adapter-defined JSON fields. */
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import type {
  DebugBreakpointView,
  DebugFrameView,
  DebugScopeView,
  DebugSessionView,
  DebugSourceView,
  DebugThreadView,
  DebugVariableView
} from "@jingler/core"

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

export interface DapSource extends DebugSourceView { readonly sourceReference?: number }
export interface DapStackFrame extends Omit<DebugFrameView, "source"> { readonly source?: DapSource }
export type DapThread = DebugThreadView
export type DapScope = DebugScopeView
export type DapVariable = DebugVariableView
export type DapBreakpoint = DebugBreakpointView
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

export type DapStatus = DebugSessionView["status"]
export type DapSessionSnapshot = DebugSessionView

export interface DapTransport {
  readonly process: ChildProcessWithoutNullStreams
  write(message: string): Promise<void>
  onData(listener: (chunk: Buffer) => void): void
  dispose(): Promise<void>
}
