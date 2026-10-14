import { ArrowRight, Mail, MailCheck } from "lucide-react"
import { Button } from "../components/button.js"
import { Callout } from "../components/callout.js"
import { Input } from "../components/input.js"
import { Spinner } from "../components/loading.js"

export type MagicLinkState = "default" | "loading" | "sent" | "error"

export interface MagicLinkFormProps {
  /** Which visual state to render. `error` shows the form (the banner lives above). */
  state?: MagicLinkState
  /**
   * "signin" sends a magic link; "signup" also collects a full name and reframes
   * the copy/icon ("Create account", confirmation wording).
   */
  mode?: "signin" | "signup"
  /** Controlled email value. */
  email: string
  /** Controlled full-name value (sign-up only). */
  name?: string
  /** The address a link was sent to (shown in the `sent` confirmation). */
  sentEmail?: string
  onEmailChange: (value: string) => void
  /** Update the full-name field (sign-up only). */
  onNameChange?: (value: string) => void
  /** Submit for a magic link (also fired on Enter). */
  onSubmit: () => void
  /** Return from the `sent` state to re-enter details. */
  onReset: () => void
  /** Send the link again from `sent`. Omit to hide Resend. */
  onResend?: () => void
  /** True during the resend cooldown: Resend reads "Sent again ✓" and is disabled. */
  resent?: boolean
}

function SentPanel({
  sentEmail,
  onReset,
  onResend,
  resent
}: Pick<MagicLinkFormProps, "sentEmail" | "onReset" | "onResend" | "resent">) {
  return (
    <div className="flex w-full flex-col items-center gap-2.5">
      <Callout tone="blue" glyph={<MailCheck className="size-3.5" />} className="w-full">
        Check <strong className="font-semibold text-text-bright">{sentEmail || "your email"}</strong> — link
        expires in 15 min
      </Callout>
      {onResend ? (
        <Button variant="secondary" size="sm" className="w-full" disabled={resent} onClick={onResend}>
          {resent ? "Sent again ✓" : "Resend"}
        </Button>
      ) : null}
      <Button variant="ghost" size="sm" onClick={onReset}>
        Use a different email
      </Button>
    </div>
  )
}

/**
 * The email magic-link control: an input + submit button that also covers the
 * loading, sent, and error states. A molecule so it can be storybooked in every
 * state independently of the full LoginScreen. In `signup` mode it adds a name
 * field above the email and swaps the action copy to account creation.
 */
export function MagicLinkForm({
  state = "default",
  mode = "signin",
  email,
  name = "",
  sentEmail,
  onEmailChange,
  onNameChange,
  onSubmit,
  onReset,
  onResend,
  resent = false
}: MagicLinkFormProps) {
  const signup = mode === "signup"

  if (state === "sent") {
    return <SentPanel sentEmail={sentEmail} onReset={onReset} onResend={onResend} resent={resent} />
  }

  const loading = state === "loading"
  return (
    <form
      className="flex w-full flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (!loading) onSubmit()
      }}
    >
      {signup ? (
        <Input
          type="text"
          placeholder="Full name"
          value={name}
          onChange={(event) => onNameChange?.(event.target.value)}
          autoComplete="name"
          aria-label="Full name"
          disabled={loading}
        />
      ) : null}
      <Input
        type="email"
        placeholder="you@company.com"
        value={email}
        onChange={(event) => onEmailChange(event.target.value)}
        autoComplete="email"
        aria-label="Email address"
        disabled={loading}
      />
      <Button type="submit" disabled={loading} className="w-full gap-1.5">
        {loading ? (
          <Spinner size={14} />
        ) : signup ? (
          <ArrowRight className="size-3.5" />
        ) : (
          <Mail className="size-3.5" />
        )}
        {loading
          ? signup
            ? "Creating account…"
            : "Sending link…"
          : signup
            ? "Create account"
            : "Send magic link"}
      </Button>
    </form>
  )
}
