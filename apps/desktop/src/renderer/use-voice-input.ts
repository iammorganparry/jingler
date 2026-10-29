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

/** Superwhisper pastes into whatever has focus, so put the caret back in this composer's textarea first. */
const focusComposer = (): void => {
  document.activeElement?.closest("[data-testid=\"composer\"]")?.querySelector("textarea")?.focus()
}

/** A "recording" Superwhisper owns: stop resolves with no WAV because the transcript arrives by paste. */
const superwhisperRecording = async (rpc: VoiceRpc): Promise<VoiceRecording> => {
  focusComposer()
  await rpc.voiceSuperwhisperRecord("start")
  const stop = () => rpc.voiceSuperwhisperRecord("stop")
  return { stop: () => stop().then(() => ""), level: () => 0, cancel: () => void stop() }
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
        if (await rpc.voiceSuperwhisperInstalled().catch(() => false)) return superwhisperRecording(rpc)
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
    onCancel: () => send({ type: "CANCEL" }),
    onDismiss: () => send({ type: "DISMISS" })
  }
}
