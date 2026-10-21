import { useMachine } from "@xstate/react"
import type { ComposerVoiceInput } from "@jingler/ui"
import { rpc } from "./rpc-client.js"
import { getDraft, setDraft } from "./draft-store.js"
import { startRecording } from "./voice-capture.js"
import { voiceInputMachine } from "./voice-input-machine.js"

/** Mic button state for one chat's composer; the transcript is appended to the draft, never sent. */
export function useVoiceInput(chatId: string): ComposerVoiceInput {
  const [state, send] = useMachine(voiceInputMachine, {
    input: {
      start: async () => {
        if (!(await rpc.voiceRequestMicrophone())) throw new Error("Microphone access is blocked in system settings")
        return startRecording()
      },
      transcribe: async (wav) => (await rpc.voiceTranscribe(wav)).text,
      onTranscript: (text) => {
        const current = getDraft(chatId)
        setDraft(chatId, { ...current, text: current.text === "" ? text : `${current.text} ${text}` })
      }
    }
  })
  const status = state.matches("idle") ? "idle" : state.value as ComposerVoiceInput["status"]
  return {
    status,
    message: state.context.error ?? undefined,
    onToggle: () => send({ type: "TOGGLE" }),
    onCancel: () => send({ type: "CANCEL" }),
    onDismiss: () => send({ type: "DISMISS" })
  }
}
