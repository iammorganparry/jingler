import { CircleAlert } from "lucide-react"
import { useState } from "react"
import { Button } from "../components/button.js"
import { Card } from "../components/card.js"

/**
 * The boot `failure` card (13.1): replaces the raw "Failed to load" line with a cause, the raw
 * error behind a disclosure, a primary Retry, and Copy diagnostics. Red is only the icon.
 */
export function BootFailureCard({
  error,
  onRetry,
  getDiagnostics
}: {
  /** Raw boot error, shown mono behind the Details disclosure. */
  error: string
  onRetry: () => void
  /** Resolves the text copied by "Copy diagnostics". */
  getDiagnostics: () => Promise<string>
}) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    void getDiagnostics()
      .then((text) => navigator.clipboard.writeText(text))
      .then(() => setCopied(true))
      .catch(() => {})
  }
  return (
    <div className="flex h-screen items-center justify-center bg-canvas p-8 text-text">
      <Card className="flex w-[460px] max-w-full flex-col gap-3.5 rounded-xl p-5">
        <div role="alert" className="flex flex-col gap-2">
          <CircleAlert size={20} className="text-state-failed" />
          <h1 className="text-[15px] font-semibold leading-[18px] text-text-bright">Jingler couldn't start</h1>
          <p className="text-[13px] leading-[19px] text-muted-foreground">
            Something went wrong while loading your workspace. Your sessions are safe.
          </p>
        </div>
        <details className="text-[12px] text-muted-foreground">
          <summary className="cursor-pointer select-none">Details</summary>
          <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-sunken p-3 font-mono text-[11.5px]">
            {error}
          </pre>
        </details>
        <div className="flex gap-2">
          <Button size="sm" onClick={onRetry}>Retry</Button>
          <Button size="sm" variant="secondary" onClick={copy}>{copied ? "Copied" : "Copy diagnostics"}</Button>
        </div>
      </Card>
    </div>
  )
}
