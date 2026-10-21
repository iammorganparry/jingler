import { assign, fromPromise, setup } from "xstate"
import type { VoiceRecording } from "./voice-capture.js"

export interface VoiceInputDeps {
  /** Ask the OS for mic access, then begin capturing. */
  readonly start: () => Promise<VoiceRecording>
  /** WAV (base64) in, transcript out; rejects with `{ reason: "no-model" }` when no whisper model is installed. */
  readonly transcribe: (wavBase64: string) => Promise<string>
  /** The transcript is only ever offered to the draft — never sent. */
  readonly onTranscript: (text: string) => void
}

interface Context {
  readonly deps: VoiceInputDeps
  readonly recording: VoiceRecording | null
  readonly error: string | null
}

const message = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error ? String(error.message) : "Voice input failed"

export const voiceInputMachine = setup({
  types: {
    context: {} as Context,
    input: {} as VoiceInputDeps,
    events: {} as { type: "TOGGLE" } | { type: "CANCEL" } | { type: "DISMISS" }
  },
  actors: {
    start: fromPromise(({ input }: { input: VoiceInputDeps }) => input.start()),
    transcribe: fromPromise(async ({ input }: { input: { deps: VoiceInputDeps; recording: VoiceRecording } }) =>
      input.deps.transcribe(await input.recording.stop())
    )
  }
}).createMachine({
  id: "voiceInput",
  context: ({ input }) => ({ deps: input, recording: null, error: null }),
  initial: "idle",
  states: {
    idle: { on: { TOGGLE: "starting" } },
    starting: {
      invoke: {
        src: "start",
        input: ({ context }) => context.deps,
        onDone: { target: "recording", actions: assign({ recording: ({ event }) => event.output }) },
        onError: { target: "error", actions: assign({ error: ({ event }) => message(event.error) }) }
      },
      on: { CANCEL: "idle" }
    },
    recording: {
      on: {
        TOGGLE: "transcribing",
        CANCEL: { target: "idle", actions: ({ context }) => context.recording?.cancel() }
      }
    },
    transcribing: {
      invoke: {
        src: "transcribe",
        input: ({ context }) => ({ deps: context.deps, recording: context.recording! }),
        onDone: {
          target: "idle",
          actions: ({ context, event }) => {
            if (event.output.length > 0) context.deps.onTranscript(event.output)
          }
        },
        onError: [
          { guard: ({ event }) => (event.error as { reason?: string })?.reason === "no-model", target: "noModel" },
          { target: "error", actions: assign({ error: ({ event }) => message(event.error) }) }
        ]
      },
      on: { CANCEL: "idle" }
    },
    error: { on: { TOGGLE: "starting", DISMISS: "idle", CANCEL: "idle" } },
    noModel: { on: { TOGGLE: "starting", DISMISS: "idle", CANCEL: "idle" } }
  }
})
