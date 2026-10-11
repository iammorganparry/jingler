import { useState } from "react"
import { Button } from "../components/button.js"
import { JinglerMark } from "../brand/jingler-mark.js"

/**
 * The root error boundary's card (spec §5g, board 25c+ F8-04): what happened, that agents keep
 * running, and three actions. Reload is the neutral primary; red is not used on this screen.
 */
export function CrashScreen({
  details,
  onReload,
  onOpenLogs
}: {
  /** Stack or message shown behind a disclosure and copied by "Copy error details". */
  details: string
  onReload: () => void
  onOpenLogs?: () => void
}) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    void navigator.clipboard
      ?.writeText(details)
      .then(() => setCopied(true))
      .catch(() => {})
  }
  return (
    <div role="alert" className="flex min-h-screen items-center justify-center bg-canvas p-6 text-text">
      <div className="flex w-[460px] max-w-full flex-col gap-3.5 rounded-xl border border-line bg-panel p-5">
        <JinglerMark className="h-5 w-auto text-brand" />
        <h1 className="text-[15px] font-semibold leading-[18px] text-text-bright">Jingler hit an error</h1>
        <p className="text-[13px] leading-[19px] text-muted-foreground">Agents keep running in the background.</p>
        <details className="text-[12px] text-muted-foreground">
          <summary className="cursor-pointer select-none">Details</summary>
          <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-sunken p-3 font-mono text-[11.5px]">
            {details}
          </pre>
        </details>
        <div className="flex gap-2">
          <Button size="sm" onClick={onReload}>Reload window</Button>
          <Button size="sm" variant="secondary" onClick={copy}>{copied ? "Copied" : "Copy error details"}</Button>
          {onOpenLogs && <Button size="sm" variant="secondary" onClick={onOpenLogs}>Open logs</Button>}
        </div>
      </div>
    </div>
  )
}
