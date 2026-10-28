import { assign, fromCallback, fromPromise, setup } from "xstate"
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
  /** Started by holding the key: releasing it (not a second press) ends the recording. */
  readonly held: boolean
  /** Key released before the mic finished opening. */
  readonly releasedEarly: boolean
  /** Input loudness 0–1 and elapsed recording time, refreshed by TICK while recording. */
  readonly level: number
  readonly elapsedMs: number
  readonly startedAt: number
}

const message = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error ? String(error.message) : "Voice input failed"

export const voiceInputMachine = setup({
  types: {
    context: {} as Context,
    input: {} as VoiceInputDeps,
    events: {} as { type: "TOGGLE" } | { type: "HOLD" } | { type: "RELEASE" } | { type: "TICK" } | { type: "CANCEL" } | { type: "DISMISS" }
  },
  actors: {
    ticker: fromCallback(({ sendBack }) => {
      const id = setInterval(() => sendBack({ type: "TICK" }), 100)
      return () => clearInterval(id)
    }),
    start: fromPromise(({ input }: { input: VoiceInputDeps }) => input.start()),
    transcribe: fromPromise(async ({ input }: { input: { deps: VoiceInputDeps; recording: VoiceRecording } }) =>
      input.deps.transcribe(await input.recording.stop())
    )
  }
}).createMachine({
  id: "voiceInput",
  context: ({ input }) => ({ deps: input, recording: null, error: null, held: false, releasedEarly: false, level: 0, elapsedMs: 0, startedAt: 0 }),
  initial: "idle",
  states: {
    idle: {
      on: {
        TOGGLE: { target: "starting", actions: assign({ held: false, releasedEarly: false }) },
        HOLD: { target: "starting", actions: assign({ held: true, releasedEarly: false }) }
      }
    },
    starting: {
      invoke: {
        src: "start",
        input: ({ context }) => context.deps,
        onDone: [
          { guard: ({ context }) => context.releasedEarly, target: "transcribing", actions: assign({ recording: ({ event }) => event.output }) },
          { target: "recording", actions: assign({ recording: ({ event }) => event.output }) }
        ],
        onError: { target: "error", actions: assign({ error: ({ event }) => message(event.error) }) }
      },
      on: { CANCEL: "idle", RELEASE: { actions: assign({ releasedEarly: ({ context }) => context.held }) } }
    },
    recording: {
      entry: assign({ level: 0, elapsedMs: 0, startedAt: () => Date.now() }),
      invoke: { src: "ticker" },
      on: {
        TICK: {
          actions: assign({
            level: ({ context }) => context.recording?.level() ?? 0,
            elapsedMs: ({ context }) => Date.now() - context.startedAt
          })
        },
        RELEASE: { guard: ({ context }) => context.held, target: "transcribing" },
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
    error: { on: { TOGGLE: { target: "starting", actions: assign({ held: false, releasedEarly: false }) }, DISMISS: "idle", CANCEL: "idle" } },
    noModel: { on: { TOGGLE: { target: "starting", actions: assign({ held: false, releasedEarly: false }) }, DISMISS: "idle", CANCEL: "idle" } }
  }
})
