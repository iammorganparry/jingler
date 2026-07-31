import type { PlanCommentMessage, PlanParticipant } from "@jingler/core"
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Clock3,
  RefreshCw,
  RotateCcw,
  Send
} from "lucide-react"
import {
  createContext,
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useContext,
  useRef,
  useState
} from "react"
import { useMachine } from "@xstate/react"
import { Button } from "../../components/button.js"
import { cn } from "../../lib/cn.js"
import { planCommentComposerMachine } from "./plan-comment-composer-machine.js"

export interface PlanCommentThreadControls {
  readonly participants: ReadonlyArray<PlanParticipant>
  /** Thread mutations wait until the containing plan revision is persisted. */
  readonly disabled?: boolean
  readonly onReply?: (
    annotationId: string,
    body: string,
    mentionedParticipantIds: ReadonlyArray<string>
  ) => Promise<void> | void
  readonly onRetry?: (
    annotationId: string,
    message: PlanCommentMessage
  ) => Promise<void> | void
  readonly onSetResolved?: (
    annotationId: string,
    resolved: boolean
  ) => Promise<void> | void
}

const PlanCommentThreadControlsContext = createContext<PlanCommentThreadControls>({
  participants: []
})

export function PlanCommentThreadControlsProvider({
  controls,
  children
}: {
  controls?: PlanCommentThreadControls
  children: React.ReactNode
}) {
  return (
    <PlanCommentThreadControlsContext.Provider
      value={controls ?? { participants: [] }}
    >
      {children}
    </PlanCommentThreadControlsContext.Provider>
  )
}

export const usePlanCommentThreadControls = () =>
  useContext(PlanCommentThreadControlsContext)

const roleLabel: Record<PlanParticipant["role"], string> = {
  orchestrator: "Orchestrator",
  worker: "Worker",
  subagent: "Sub-agent"
}

const lifecycleLabel: Record<PlanParticipant["lifecycle"], string> = {
  parked: "Parked",
  running: "Active"
}

const participantContextLabel = (
  participant: PlanParticipant,
  participants: ReadonlyArray<PlanParticipant>
): string => {
  const base = `${roleLabel[participant.role]} · ${lifecycleLabel[participant.lifecycle]}`
  if (participant.role !== "subagent" || participant.ownerRoutingId === null) {
    return base
  }
  const owner = participants.find(
    ({ routingId }) => routingId === participant.ownerRoutingId
  )
  const ownerName = owner?.displayName ?? participant.ownerRoutingId
  const ownerAttempt = participant.ownerRoutingId.startsWith("worker:")
    ? `attempt ${participant.ownerRoutingId.split(":").at(-1)}`
    : participant.ownerRoutingId.slice("orchestrator:".length)
  const subagentIdentity = participant.routingId.slice(
    `subagent:${participant.ownerRoutingId}:`.length
  )
  return `${base} · ${ownerName} · ${ownerAttempt} · ${subagentIdentity}`
}

const mentionMatch = (value: string): { readonly start: number; readonly query: string } | null => {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(value)
  if (match === null) return null
  return {
    start: value.length - match[1]!.length - 1,
    query: match[1]!.toLocaleLowerCase()
  }
}

export function PlanCommentComposer({
  participants,
  placeholder = "Reply to this thread…",
  autoFocus = false,
  disabled = false,
  onSubmit,
  onCancel
}: {
  participants: ReadonlyArray<PlanParticipant>
  placeholder?: string
  autoFocus?: boolean
  disabled?: boolean
  onSubmit: (
    body: string,
    mentionedParticipantIds: ReadonlyArray<string>
  ) => Promise<boolean | void> | boolean | void
  onCancel?: () => void
}) {
  const onSubmitRef = useRef(onSubmit)
  onSubmitRef.current = onSubmit
  const getOnSubmit = useCallback(() => onSubmitRef.current, [])
  const [state, send] = useMachine(planCommentComposerMachine, {
    input: { getOnSubmit }
  })
  const { value, activeIndex } = state.context
  const submitting = state.matches("submitting")
  const match = mentionMatch(value)
  const suggestions = (() => {
    if (match === null) return []
    return participants.filter((participant) => {
      const searchable = `${participant.displayName} ${roleLabel[participant.role]} ${lifecycleLabel[participant.lifecycle]}`.toLocaleLowerCase()
      return searchable.includes(match.query)
    })
  })()

  const choose = (participant: PlanParticipant) => {
    if (match === null) return
    const token = `@${participant.displayName}`
    send({
      type: "choose",
      value: `${value.slice(0, match.start)}${token} ${value.slice(match.start + match.query.length + 1)}`,
      mention: { routingId: participant.routingId, token }
    })
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (disabled) return
    send({ type: "submit" })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      if (match !== null) {
        send({ type: "change", value: value.slice(0, match.start) })
        event.preventDefault()
      } else {
        onCancel?.()
      }
      return
    }
    if (suggestions.length === 0) return
    if (event.key === "ArrowDown") {
      send({ type: "move", index: (activeIndex + 1) % suggestions.length })
      event.preventDefault()
    } else if (event.key === "ArrowUp") {
      send({
        type: "move",
        index: (activeIndex - 1 + suggestions.length) % suggestions.length
      })
      event.preventDefault()
    } else if (event.key === "Enter" && !event.shiftKey) {
      choose(suggestions[activeIndex] ?? suggestions[0]!)
      event.preventDefault()
    }
  }

  return (
    <form className="relative" onSubmit={submit}>
      {suggestions.length > 0 && (
        <div
          role="listbox"
          aria-label="Mention an agent"
          className="absolute inset-x-0 bottom-full z-20 mb-1 max-h-48 overflow-auto rounded-lg border border-line bg-sunken p-1 shadow-lg"
        >
          {suggestions.map((participant, index) => (
            <button
              key={participant.routingId}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(participant)}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring",
                index === activeIndex && "bg-surface"
              )}
            >
              <span className="flex size-6 items-center justify-center rounded-full bg-purple/10 text-[10px] font-bold text-purple">
                {participant.displayName.slice(0, 1).toLocaleUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[11.5px] font-semibold text-text-bright">
                  {participant.displayName}
                </span>
                <span className="block text-[10px] text-muted-foreground">
                  {participantContextLabel(participant, participants)}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
      <div className="flex items-end gap-1.5 rounded-lg border border-line bg-editor p-1.5 focus-within:border-line-strong">
        <textarea
          autoFocus={autoFocus}
          value={value}
          disabled={disabled || submitting}
          rows={2}
          aria-label={placeholder}
          placeholder={placeholder}
          onChange={(event) => {
            send({ type: "change", value: event.target.value })
          }}
          onKeyDown={onKeyDown}
          className="min-h-12 min-w-0 flex-1 resize-none bg-transparent px-1.5 py-1 text-[11.5px] leading-relaxed text-text-body outline-none placeholder:text-dim disabled:opacity-60"
        />
        <button
          type="submit"
          aria-label="Send reply"
          disabled={disabled || submitting || value.trim().length === 0}
          className="flex size-8 flex-none items-center justify-center rounded-md bg-brand text-primary-foreground outline-none transition-[background-color,opacity,scale] hover:bg-brand-hover focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.96] disabled:opacity-40"
        >
          {submitting ? (
            <RefreshCw className="size-3.5 animate-spin" />
          ) : (
            <Send className="size-3.5" />
          )}
        </button>
      </div>
      <p className="mt-1 text-[9.5px] text-dim">
        Type @ to mention the orchestrator or an active agent.
      </p>
    </form>
  )
}

const timestamp = (createdAt: string): string => {
  const date = new Date(createdAt)
  if (Number.isNaN(date.valueOf())) return createdAt
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date)
}

const authorLabel = (
  message: PlanCommentMessage,
  participants: ReadonlyArray<PlanParticipant>
): string => {
  if (message.authorKind === "user") return "You"
  if (message.authorId === "jingler:dispatcher") return "Jingler"
  return (
    participants.find((participant) => participant.routingId === message.authorId)
      ?.displayName ?? message.authorId
  )
}

function Delivery({ message }: { message: PlanCommentMessage }) {
  if (message.deliveryState === "pending") {
    return (
      <span className="inline-flex items-center gap-1 text-yellow">
        <Clock3 className="size-3" /> Sending
      </span>
    )
  }
  if (message.deliveryState === "failed") {
    return (
      <span className="inline-flex items-center gap-1 text-red">
        <AlertCircle className="size-3" /> Delivery failed
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 text-muted-foreground">
      <Check className="size-3" /> Sent
    </span>
  )
}

export function PlanCommentThread({
  annotationId,
  status,
  messages
}: {
  annotationId: string
  status: "open" | "resolved"
  messages: ReadonlyArray<PlanCommentMessage>
}) {
  const controls = usePlanCommentThreadControls()
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const threadPending = messages.some(
    (message) => message.deliveryState === "pending"
  )

  const run = async (
    key: string,
    action: () => Promise<void> | void
  ): Promise<boolean> => {
    setBusyAction(key)
    setActionError(null)
    try {
      await action()
      return true
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "The thread could not be updated."
      )
      return false
    } finally {
      setBusyAction(null)
    }
  }

  return (
    <div className="flex min-h-0 flex-col" data-plan-comment-thread={annotationId}>
      <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold text-text-bright">Plan thread</p>
          <p className="text-[9.5px] text-muted-foreground">
            {messages.length} {messages.length === 1 ? "message" : "messages"}
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          disabled={
            busyAction !== null ||
            threadPending ||
            controls.disabled === true ||
            controls.onSetResolved === undefined
          }
          onClick={() =>
            void run("status", () =>
              controls.onSetResolved?.(annotationId, status !== "resolved")
            )
          }
        >
          {status === "resolved" ? (
            <RotateCcw className="size-3.5" />
          ) : (
            <CheckCircle2 className="size-3.5" />
          )}
          {status === "resolved" ? "Reopen" : "Resolve"}
        </Button>
      </div>

      <ol className="flex max-h-72 flex-col gap-3 overflow-y-auto px-3 py-3">
        {messages.map((message) => (
          <li key={message.id} className="flex gap-2.5">
            <span
              className={cn(
                "mt-0.5 flex size-6 flex-none items-center justify-center rounded-full text-[9px] font-bold",
                message.authorKind === "agent"
                  ? "bg-purple/10 text-purple"
                  : "bg-blue/10 text-blue"
              )}
            >
              {authorLabel(message, controls.participants)
                .slice(0, 1)
                .toLocaleUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-1.5">
                <span className="text-[10.5px] font-semibold text-text-bright">
                  {authorLabel(message, controls.participants)}
                </span>
                <time
                  dateTime={message.createdAt}
                  className="text-[9px] text-dim"
                >
                  {timestamp(message.createdAt)}
                </time>
              </div>
              <p className="mt-1 whitespace-pre-wrap text-[11.5px] leading-relaxed text-text-body">
                {message.body}
              </p>
              <div className="mt-1.5 flex items-center gap-2 text-[9.5px]">
                <Delivery message={message} />
                {message.deliveryState === "failed" &&
                  message.authorKind === "user" &&
                  controls.onRetry !== undefined && (
                    <button
                      type="button"
                      disabled={busyAction !== null || controls.disabled === true}
                      onClick={() =>
                        void run(`retry:${message.id}`, () =>
                          controls.onRetry?.(annotationId, message)
                        )
                      }
                      className="inline-flex items-center gap-1 rounded text-red outline-none hover:text-text-bright focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                    >
                      <RefreshCw className="size-3" /> Retry delivery
                    </button>
                  )}
              </div>
            </div>
          </li>
        ))}
      </ol>

      <div className="border-t border-line px-3 py-3">
        {actionError !== null && (
          <p role="alert" className="mb-2 text-[10px] text-red">
            {actionError}
          </p>
        )}
        {status === "resolved" ? (
          <p className="flex items-center justify-center gap-1.5 rounded-lg bg-surface px-3 py-2 text-[10.5px] text-muted-foreground">
            <CheckCircle2 className="size-3.5 text-green" /> Thread resolved
          </p>
        ) : (
          <PlanCommentComposer
            participants={controls.participants}
            disabled={
              busyAction !== null ||
              controls.disabled === true ||
              controls.onReply === undefined ||
              threadPending
            }
            onSubmit={(body, mentionedParticipantIds) =>
              run("reply", () =>
                controls.onReply?.(
                  annotationId,
                  body,
                  mentionedParticipantIds
                )
              )
            }
          />
        )}
      </div>
    </div>
  )
}
