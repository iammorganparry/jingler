import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import {
  ExternalLink,
  Play,
  RefreshCw,
  RotateCw,
  Smartphone,
  Square,
  Terminal
} from "lucide-react"
import {
  definePlugin,
  useHost,
  type HostBridge,
  type SessionSnapshot,
  type TabProps
} from "@jingler/plugin-sdk"
import { Spinner, StatusDot, cn } from "@jingler/plugin-sdk/ui"
import type { ExpoFrame, ExpoSessionInput, ExpoStatus } from "./contracts.js"
import { manifest } from "./manifest.js"

const STATUS_INTERVAL_MS = 1_000
const FRAME_INTERVAL_MS = 750
const CAPTURE_RETRY_MS = 1_500
const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

type SetState<T> = React.Dispatch<React.SetStateAction<T>>

function useInitialStatus(
  host: HostBridge,
  input: ExpoSessionInput,
  setStatus: SetState<ExpoStatus | null>,
  setError: SetState<string | null>,
  resetFrame: () => void
): void {
  useEffect(() => {
    let cancelled = false
    setStatus(null)
    setError(null)
    resetFrame()
    host
      .invoke<ExpoStatus>("expo.status", input)
      .then((next) => {
        if (!cancelled) setStatus(next)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(messageOf(cause))
      })
    return () => {
      cancelled = true
    }
  }, [host, input, resetFrame, setError, setStatus])
}

function useStatusPolling(
  host: HostBridge,
  input: ExpoSessionInput,
  status: ExpoStatus | null,
  setStatus: SetState<ExpoStatus | null>,
  setError: SetState<string | null>
): void {
  useEffect(() => {
    if (status?.phase !== "starting" && status?.phase !== "running") return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const next = await host.invoke<ExpoStatus>("expo.status", input)
        if (!cancelled) setStatus(next)
      } catch (cause) {
        if (!cancelled) setError(messageOf(cause))
      } finally {
        if (!cancelled) timer = setTimeout(poll, STATUS_INTERVAL_MS)
      }
    }
    timer = setTimeout(poll, STATUS_INTERVAL_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [host, input, setError, setStatus, status?.phase])
}

function useFramePolling(
  host: HostBridge,
  input: ExpoSessionInput,
  status: ExpoStatus | null,
  setStatus: SetState<ExpoStatus | null>,
  setFrame: SetState<ExpoFrame | null>,
  setFrameError: SetState<string | null>
): void {
  useEffect(() => {
    if (status?.phase !== "starting" && status?.phase !== "running") return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const capture = async () => {
      let delay = FRAME_INTERVAL_MS
      try {
        const next = await host.invoke<ExpoFrame>("expo.frame", input)
        if (!cancelled) {
          setFrame(next)
          setFrameError(null)
          setStatus((current) =>
            current ? { ...current, phase: "running", simulator: next.device } : current
          )
        }
      } catch (cause) {
        delay = CAPTURE_RETRY_MS
        if (!cancelled) setFrameError(messageOf(cause))
      } finally {
        if (!cancelled) timer = setTimeout(capture, delay)
      }
    }
    capture().catch((cause: unknown) => setFrameError(messageOf(cause)))
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [host, input, setFrame, setFrameError, setStatus, status?.phase])
}

interface PreviewModel {
  readonly status: ExpoStatus | null
  readonly frame: ExpoFrame | null
  readonly error: string | null
  readonly frameError: string | null
  readonly busy: boolean
  readonly start: () => Promise<void>
  readonly stop: () => Promise<void>
  readonly reload: () => Promise<void>
  readonly openSimulator: () => Promise<void>
  readonly retry: () => Promise<void>
}

function usePreviewModel(session: SessionSnapshot): PreviewModel {
  const host = useHost()
  const input = useMemo<ExpoSessionInput>(
    () => ({ sessionId: session.id, worktreePath: session.worktreePath }),
    [session.id, session.worktreePath]
  )
  const [status, setStatus] = useState<ExpoStatus | null>(null)
  const [frame, setFrame] = useState<ExpoFrame | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [frameError, setFrameError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const resetFrame = useCallback(() => {
    setFrame(null)
    setFrameError(null)
  }, [])
  const refresh = useCallback(async () => {
    setStatus(await host.invoke<ExpoStatus>("expo.status", input))
  }, [host, input])

  useInitialStatus(host, input, setStatus, setError, resetFrame)
  useStatusPolling(host, input, status, setStatus, setError)
  useFramePolling(host, input, status, setStatus, setFrame, setFrameError)

  const run = useCallback(async (operation: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await operation()
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }, [])
  const command = useCallback(
    async (id: string, update = false) => {
      await run(async () => {
        const result = await host.invoke<ExpoStatus>(id, input)
        if (update) setStatus(result)
      })
    },
    [host, input, run]
  )
  return {
    status,
    frame,
    error,
    frameError,
    busy,
    start: async () => {
      resetFrame()
      await command("expo.start", true)
    },
    stop: async () => {
      await command("expo.stop", true)
      resetFrame()
    },
    reload: () => command("expo.reload"),
    openSimulator: () => command("expo.open-simulator"),
    retry: () => run(refresh)
  }
}

function ToolbarButton({
  label,
  disabled = false,
  onClick,
  children
}: {
  readonly label: string
  readonly disabled?: boolean
  readonly onClick: () => void
  readonly children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex h-7 items-center gap-1.5 rounded border border-line px-2 text-[11.5px] text-text-body transition-colors hover:border-blue hover:text-text-bright disabled:pointer-events-none disabled:opacity-45"
    >
      {children}
    </button>
  )
}

function SetupState({ model }: { readonly model: PreviewModel }) {
  const { status, busy } = model
  if (!status) return null
  return (
    <div className="flex flex-1 items-center justify-center bg-editor p-6">
      <div className="flex max-w-[460px] flex-col items-center text-center">
        <div className="flex size-12 items-center justify-center rounded-xl border border-line bg-panel text-blue">
          <Smartphone className="size-6" />
        </div>
        <h2 className="mt-4 text-[15px] font-semibold text-text-bright">Expo iOS Preview</h2>
        <p className="mt-2 text-[12.5px] leading-[1.6] text-dim">
          {status.ready
            ? "Start the local Expo CLI and mirror its default iOS Simulator here. Interaction stays in Simulator."
            : status.reason}
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={status.ready ? model.start : model.retry}
          className={cn(
            "mt-5 flex h-8 items-center gap-2 rounded px-3 text-[12px] font-medium disabled:opacity-50",
            status.ready ? "bg-blue text-panel" : "border border-line text-text-body"
          )}
        >
          {busy ? <Spinner size={13} /> : status.ready ? <Play className="size-3.5" /> : <RefreshCw className="size-3.5" />}
          {status.ready ? "Start iOS Preview" : "Retry check"}
        </button>
      </div>
    </div>
  )
}

function PreviewToolbar({ model }: { readonly model: PreviewModel }) {
  const status = model.status
  if (!status) return null
  const active = status.phase === "starting" || status.phase === "running"
  return (
    <div className="flex min-h-10 flex-wrap items-center gap-2 border-b border-line bg-panel px-2 py-1.5">
      <div className="flex min-w-0 items-center gap-2 px-1">
        <StatusDot
          tone={status.phase === "running" ? "bg-green" : status.phase === "failed" ? "bg-red" : "bg-yellow"}
          pulse={status.phase === "starting"}
        />
        <span className="truncate text-[12px] font-medium text-text-bright">
          {status.phase === "running" ? status.simulator?.name ?? "iOS Simulator" : status.phase === "failed" ? "Expo stopped" : "Starting Expo…"}
        </span>
      </div>
      <div className="ml-auto flex items-center gap-1">
        <ToolbarButton label="Reload Expo app" disabled={model.busy || !active} onClick={model.reload}>
          <RotateCw className="size-3" /> Reload
        </ToolbarButton>
        <ToolbarButton label="Open Simulator" disabled={model.busy} onClick={model.openSimulator}>
          <ExternalLink className="size-3" /> Simulator
        </ToolbarButton>
        <ToolbarButton
          label={active ? "Stop Expo preview" : "Retry Expo preview"}
          disabled={model.busy}
          onClick={active ? model.stop : model.start}
        >
          {active ? <Square className="size-3" /> : <RefreshCw className="size-3" />}
          {active ? "Stop" : "Retry"}
        </ToolbarButton>
      </div>
    </div>
  )
}

function PreviewCanvas({ model }: { readonly model: PreviewModel }) {
  const status = model.status
  return (
    <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-sunken p-4">
      {model.frame ? (
        <img
          data-testid="expo-simulator-frame"
          src={`data:image/png;base64,${model.frame.pngBase64}`}
          alt={`${model.frame.device.name} screen`}
          className="max-h-full max-w-full rounded-[24px] border border-line object-contain shadow-2xl"
        />
      ) : (
        <div className="flex flex-col items-center gap-3 text-dim">
          {status?.phase === "starting" ? <Spinner size={22} /> : <Smartphone className="size-8" />}
          <span className="text-[12px]">
            {status?.phase === "failed" ? status.error ?? "Expo exited." : "Waiting for Simulator…"}
          </span>
        </div>
      )}
    </div>
  )
}

function ExpoOutput({ model }: { readonly model: PreviewModel }) {
  const status = model.status
  if (!status || !(model.error || model.frameError || status.logs.length > 0)) return null
  return (
    <details className="flex-none border-t border-line bg-panel" open={status.phase === "failed"}>
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-[11.5px] text-dim">
        <Terminal className="size-3.5" /> Expo output
        {(model.error || model.frameError) && <span className="text-red">— {model.error ?? model.frameError}</span>}
      </summary>
      <pre className={cn("max-h-32 overflow-auto border-t border-line bg-sunken px-3 py-2 font-mono text-[10.5px] leading-relaxed text-text-body", status.logs.length === 0 && "text-dim")}>
        {status.logs.length > 0 ? status.logs.join("\n") : model.error ?? model.frameError}
      </pre>
    </details>
  )
}

export function ExpoTab({ session }: TabProps) {
  const model = usePreviewModel(session)
  if (!model.status && !model.error) {
    return <div className="flex flex-1 items-center justify-center bg-editor text-dim"><Spinner size={20} /></div>
  }
  if (!model.status) {
    return <div role="alert" className="flex flex-1 flex-col items-center justify-center bg-editor p-6"><p className="max-w-[460px] text-center text-[12.5px] text-red">{model.error}</p><button type="button" onClick={model.retry} className="mt-4 rounded border border-line px-3 py-1.5 text-[12px] text-text-body">Retry</button></div>
  }
  const active = model.status.phase === "starting" || model.status.phase === "running"
  if (!active && model.status.phase !== "failed") return <SetupState model={model} />
  return <div className="flex min-h-0 flex-1 flex-col bg-editor"><PreviewToolbar model={model} /><PreviewCanvas model={model} /><ExpoOutput model={model} /></div>
}

export default definePlugin(manifest, { views: { "expo.preview": ExpoTab } })
