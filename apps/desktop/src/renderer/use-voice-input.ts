import { useEffect, useRef } from "react"
import { useMachine } from "@xstate/react"
import type { ComposerVoiceInput } from "@jingler/ui"
import { getDraft, setDraft } from "./draft-store.js"
import { startRecording, type VoiceRecording } from "./voice-capture.js"
import { voiceInputMachine } from "./voice-input-machine.js"

/** Mic button state for one chat's composer; the transcript is appended to the draft, never sent. */
export interface VoiceRpc {
  voiceRequestMicrophone: () => Promise<boolean>
  voiceTranscribe: (wavBase64: string, language?: string, modelId?: string) => Promise<{ text: string }>
  voiceSuperwhisperInstalled: () => Promise<boolean>
  voiceSuperwhisperRecord: (action: "start" | "stop") => Promise<void>
}

/**
 * A "recording" Superwhisper owns: stop resolves with no WAV because the transcript arrives by paste into whatever
 * has focus, so the composer's textarea is captured at start and refocused before each deep link (clicking Stop
 * focuses the button). Superwhisper has no discard deep link, so the composer hides Cancel; `cancel` only stops it.
 */
const superwhisperRecording = async (rpc: VoiceRpc, textarea: HTMLTextAreaElement | null | undefined): Promise<VoiceRecording> => {
  const send = (action: "start" | "stop") => {
    textarea?.focus()
    return rpc.voiceSuperwhisperRecord(action)
  }
  await send("start")
  return { stop: () => send("stop").then(() => ""), level: () => 0 }
}

/** Saved dictation prefs: whisper `-l` code, installed model id, and the `KeyboardEvent.code` held to talk ("none" = off). */
export interface VoicePrefs {
  readonly language?: string
  readonly modelId?: string
  readonly holdKey?: string
}

export const DEFAULT_HOLD_KEY = "F9"

/** `config` is the workspace config; only its `voice` prefs are read. */
export function useVoiceInput(chatId: string, rpc: VoiceRpc, config?: { readonly voice?: VoicePrefs | undefined } | null): ComposerVoiceInput {
  const prefsRef = useRef<VoicePrefs>({})
  prefsRef.current = config?.voice ?? {}
  const [state, send] = useMachine(voiceInputMachine, {
    input: {
      start: async () => {
        // Captured before any await: the mic button disables while starting, which drops focus to <body>.
        const textarea = document.activeElement?.closest("[data-testid=\"composer\"]")?.querySelector("textarea")
        if (await rpc.voiceSuperwhisperInstalled().catch(() => false)) return superwhisperRecording(rpc, textarea)
        if (!(await rpc.voiceRequestMicrophone())) throw new Error("Microphone access is blocked in system settings")
        return startRecording()
      },
      transcribe: async (wav) => wav === "" ? "" : (await rpc.voiceTranscribe(wav, prefsRef.current.language, prefsRef.current.modelId)).text,
      onTranscript: (text) => {
        const current = getDraft(chatId)
        setDraft(chatId, { ...current, text: current.text === "" ? text : `${current.text} ${text}` })
      }
    }
  })
  const holdKey = prefsRef.current.holdKey ?? DEFAULT_HOLD_KEY
  useEffect(() => {
    if (holdKey === "none") return
    const down = (event: KeyboardEvent) => {
      if (event.code === holdKey && !event.repeat) send({ type: "HOLD" })
    }
    const up = (event: KeyboardEvent) => {
      if (event.code === holdKey) send({ type: "RELEASE" })
    }
    window.addEventListener("keydown", down)
    window.addEventListener("keyup", up)
    return () => {
      window.removeEventListener("keydown", down)
      window.removeEventListener("keyup", up)
    }
  }, [holdKey, send])
  const status = state.matches("idle") ? "idle" : state.value as ComposerVoiceInput["status"]
  return {
    status,
    message: state.context.error ?? undefined,
    level: state.context.level,
    elapsedMs: state.context.elapsedMs,
    onToggle: () => send({ type: "TOGGLE" }),
    ...(state.context.recording !== null && state.context.recording.cancel === undefined ? {} : { onCancel: () => send({ type: "CANCEL" }) }),
    onDismiss: () => send({ type: "DISMISS" })
  }
}
