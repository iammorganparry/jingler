import { assign, setup } from "xstate"

export const MAX_VISIBLE_TOASTS = 3
export const TOAST_DURATION_MS = 6000
// ponytail: one polling tick drives every toast's countdown; per-toast child actors if toasts ever need individual durations.
export const TOAST_TICK_MS = 100

export type ToastVariant = "success" | "error" | "needs-you" | "info"

export interface ToastInput {
  /** Dedupe key: pushing an existing key replaces that toast and restarts its timer. */
  key: string
  variant: ToastVariant
  title: string
  description?: string
  action?: { label: string; onAction: () => void }
  /** Toasts for a session the user is already viewing are dropped. */
  sessionId?: string
}

export interface ToastItem extends ToastInput {
  remainingMs: number
}

interface ToastContext {
  toasts: ReadonlyArray<ToastItem>
  isSessionVisible: (sessionId: string) => boolean
}

type ToastEvent =
  | { type: "PUSH"; toast: ToastInput }
  | { type: "DISMISS"; key: string }
  | { type: "PAUSE" }
  | { type: "RESUME" }

export const toastMachine = setup({
  types: {
    context: {} as ToastContext,
    events: {} as ToastEvent,
    input: {} as { isSessionVisible?: (sessionId: string) => boolean } | undefined
  },
  guards: {
    isSuppressed: ({ context, event }) =>
      event.type === "PUSH" &&
      event.toast.sessionId !== undefined &&
      context.isSessionVisible(event.toast.sessionId),
    hasToasts: ({ context }) => context.toasts.length > 0,
    isEmpty: ({ context }) => context.toasts.length === 0
  },
  actions: {
    push: assign({
      toasts: ({ context, event }) => {
        if (event.type !== "PUSH") return context.toasts
        const next: ToastItem = { ...event.toast, remainingMs: TOAST_DURATION_MS }
        const exists = context.toasts.some((toast) => toast.key === next.key)
        const merged = exists
          ? context.toasts.map((toast) => (toast.key === next.key ? next : toast))
          : [...context.toasts, next]
        return merged.slice(-MAX_VISIBLE_TOASTS)
      }
    }),
    dismiss: assign({
      toasts: ({ context, event }) =>
        event.type === "DISMISS" ? context.toasts.filter((toast) => toast.key !== event.key) : context.toasts
    }),
    tick: assign({
      toasts: ({ context }) =>
        context.toasts
          .map((toast) => ({ ...toast, remainingMs: toast.remainingMs - TOAST_TICK_MS }))
          .filter((toast) => toast.remainingMs > 0)
    })
  }
}).createMachine({
  id: "toast",
  context: ({ input }) => ({ toasts: [], isSessionVisible: input?.isSessionVisible ?? (() => false) }),
  initial: "idle",
  on: {
    PUSH: [{ guard: "isSuppressed" }, { actions: "push" }],
    DISMISS: { actions: "dismiss" }
  },
  states: {
    idle: { always: { guard: "hasToasts", target: "running" } },
    running: {
      always: { guard: "isEmpty", target: "idle" },
      after: { [TOAST_TICK_MS]: { target: "running", actions: "tick", reenter: true } },
      on: { PAUSE: "paused" }
    },
    paused: {
      always: { guard: "isEmpty", target: "idle" },
      on: { RESUME: "running" }
    }
  }
})
