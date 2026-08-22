export interface DebugSourceView { readonly name?: string; readonly path?: string }
export interface DebugFrameView {
  readonly id: number
  readonly name: string
  readonly source?: DebugSourceView
  readonly line: number
  readonly column: number
  readonly instructionPointerReference?: string
}
export interface DebugThreadView { readonly id: number; readonly name: string }
export interface DebugBreakpointView { readonly id?: number; readonly verified?: boolean; readonly line?: number; readonly message?: string }
export interface DebugScopeView { readonly name: string; readonly variablesReference: number; readonly expensive: boolean; readonly presentationHint?: string }
export interface DebugVariableView { readonly name: string; readonly value: string; readonly type?: string; readonly variablesReference: number; readonly evaluateName?: string; readonly memoryReference?: string }
export interface DebugSessionView {
  readonly id: string
  readonly adapter: string
  readonly cwd: string
  readonly program?: string
  readonly status: "starting" | "running" | "stopped" | "terminated" | "error"
  readonly stopReason?: string
  readonly stopSequence?: number
  readonly threadId?: number
  readonly frame?: DebugFrameView
  readonly threads: readonly DebugThreadView[]
  readonly stackFrames: readonly DebugFrameView[]
  readonly breakpoints: Readonly<Record<string, readonly DebugBreakpointView[]>>
  readonly output: string
  readonly exitCode?: number
}
export interface DebugActionView {
  readonly id: number
  readonly action: string
  readonly status: "running" | "success" | "error"
  readonly at: string
  readonly summary: string
}
export interface DebugViewSnapshot {
  readonly active: boolean
  readonly session: DebugSessionView | null
  readonly scopes: readonly DebugScopeView[]
  readonly variables: Readonly<Record<number, readonly DebugVariableView[]>>
  readonly actions: readonly DebugActionView[]
  readonly error: string | null
}
export type DebugControlAction = "pause" | "continue" | "step_over" | "step_in" | "step_out" | "terminate"
