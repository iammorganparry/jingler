import { Check, Copy, ExternalLink } from "lucide-react"
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
}

/** Device-code OAuth step: large mono code, copy, expiry countdown, and a way back into the browser. */
export function DeviceCodeBlock({
  code,
  verificationUri,
  expiresInSeconds,
  onReopenBrowser
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
    await navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-line bg-sunken p-4 text-center">
      <span className="text-[11px] text-muted-foreground">
        Enter this code at <span className="text-text-body">{verificationUri}</span>
      </span>
      <div className="flex items-center gap-2">
        <span data-testid="device-code" className="font-mono text-[20px] font-semibold tracking-wide text-text-bright">
          {code}
        </span>
        <Button variant="ghost" size="sm" aria-label="Copy code" onClick={copyCode}>
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </Button>
      </div>
      {remaining !== null && (
        <span data-testid="device-code-countdown" className="font-mono text-[10.5px] text-dim">
          Expires in {formatCountdown(remaining)}
        </span>
      )}
      <Button variant="secondary" size="sm" onClick={onReopenBrowser}>
        <ExternalLink size={12} /> Reopen browser
      </Button>
    </div>
  )
}
