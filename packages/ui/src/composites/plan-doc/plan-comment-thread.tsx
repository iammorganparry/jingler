import type { PlanCommentMessage } from "@jingler/core"
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
const PlanCommentThreadControlsContext = createContext<PlanCommentThreadControls>({})

export function PlanCommentThreadControlsProvider({
  controls,
  children
}: {
  controls?: PlanCommentThreadControls
  children: React.ReactNode
}) {
  return (
    <PlanCommentThreadControlsContext.Provider
      value={controls ?? {}}
    >
      {children}
    </PlanCommentThreadControlsContext.Provider>
  )
}

export const usePlanCommentThreadControls = () =>
  useContext(PlanCommentThreadControlsContext)

export function PlanCommentComposer({
  placeholder = "Reply to this thread…",
  autoFocus = false,
  disabled = false,
  onSubmit,
  onCancel
}: {
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
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (disabled) return
    send({ type: "submit" })
  }


  return (
    <form className="relative" onSubmit={submit}>
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
        This comment is handled by the selected workspace agent.
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

const authorLabel = (message: PlanCommentMessage): string => {
  if (message.authorKind === "user") return "You"
  if (message.authorId === "jingler:dispatcher") return "Jingler"
  return "Agent"
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
              {authorLabel(message)
                .slice(0, 1)
                .toLocaleUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-1.5">
                <span className="text-[10.5px] font-semibold text-text-bright">
                  {authorLabel(message)}
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
