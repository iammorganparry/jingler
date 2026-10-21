import { useEffect, useRef } from "react"
import { useMachine } from "@xstate/react"
import type { ComposerVoiceInput } from "@jingler/ui"
import { getDraft, setDraft } from "./draft-store.js"
import { startRecording } from "./voice-capture.js"
import { voiceInputMachine } from "./voice-input-machine.js"

/** Mic button state for one chat's composer; the transcript is appended to the draft, never sent. */
export interface VoiceRpc {
  voiceRequestMicrophone: () => Promise<boolean>
  voiceTranscribe: (wavBase64: string, language?: string, modelId?: string) => Promise<{ text: string }>
}

/** Saved dictation prefs: whisper `-l` code, installed model id, and the `KeyboardEvent.code` held to talk ("none" = off). */
export interface VoicePrefs {
  readonly language?: string
  readonly modelId?: string
  readonly holdKey?: string
}

export const DEFAULT_HOLD_KEY = "F9"

export function useVoiceInput(chatId: string, rpc: VoiceRpc, prefs: VoicePrefs = {}): ComposerVoiceInput {
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs
  const [state, send] = useMachine(voiceInputMachine, {
    input: {
      start: async () => {
        if (!(await rpc.voiceRequestMicrophone())) throw new Error("Microphone access is blocked in system settings")
        return startRecording()
      },
      transcribe: async (wav) => (await rpc.voiceTranscribe(wav, prefsRef.current.language, prefsRef.current.modelId)).text,
      onTranscript: (text) => {
        const current = getDraft(chatId)
        setDraft(chatId, { ...current, text: current.text === "" ? text : `${current.text} ${text}` })
      }
    }
  })
  const holdKey = prefs.holdKey ?? DEFAULT_HOLD_KEY
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
