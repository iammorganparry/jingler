import { Check, Clock, Copy, ExternalLink } from "lucide-react"
import { useEffect, useState } from "react"
import { Button } from "./button.js"

const formatCountdown = (seconds: number): string => {
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${minutes}:${String(rest).padStart(2, "0")}`
}

export interface DeviceCodeBlockProps {
  /** The short user-facing device code, shown in 20px mono. */
  code: string
  verificationUri: string
  /** Seconds remaining until the code expires; null hides the countdown. */
  expiresInSeconds: number | null
  onReopenBrowser: () => void
  /** Renders Cancel next to Reopen browser (board 15b). */
  onCancel?: () => void
}

/** Device-code OAuth step (board 15b): mono code + Copy, expiry countdown, Reopen browser / Cancel. */
export function DeviceCodeBlock({
  code,
  verificationUri,
  expiresInSeconds,
  onReopenBrowser,
  onCancel
}: DeviceCodeBlockProps) {
  const [remaining, setRemaining] = useState(expiresInSeconds)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    setRemaining(expiresInSeconds)
  }, [expiresInSeconds])

  useEffect(() => {
    if (remaining === null || remaining <= 0) return
    const timer = setInterval(() => {
      setRemaining((value) => (value === null ? null : Math.max(0, value - 1)))
    }, 1000)
    return () => clearInterval(timer)
  }, [remaining])

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard refused (sandboxed view); the code stays selectable.
    }
  }

  return (
    <div className="flex flex-col items-center gap-4 rounded-xl border border-hairline bg-panel px-6 py-8 text-center">
      <div className="flex flex-col items-center gap-1">
        <span className="text-[13px] text-muted-foreground">Enter this device code in the opened browser</span>
        <span className="font-mono text-[11px] text-dim">{verificationUri}</span>
      </div>
      <div className="flex items-center gap-3 rounded-lg border border-line bg-canvas px-4 py-3">
        <span data-testid="device-code" className="select-all font-mono text-[20px] leading-7 tracking-[0.12em] text-text-bright">
          {code}
        </span>
        <Button variant="secondary" size="sm" aria-label="Copy code" onClick={copyCode} className="px-2.5">
          {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      {remaining !== null && (
        <span data-testid="device-code-countdown" className="flex items-center gap-1.5 font-mono text-[12px] text-muted-foreground">
          <Clock size={14} className="text-dim" /> Expires in {formatCountdown(remaining)}
        </span>
      )}
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" onClick={onReopenBrowser}>
          <ExternalLink size={14} /> Reopen browser
        </Button>
        {onCancel && (
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  )
}
