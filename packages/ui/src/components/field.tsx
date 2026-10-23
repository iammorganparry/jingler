import * as React from "react"
import { cn } from "../lib/cn.js"

/**
 * Label + control + help/error. The control is passed as a render function so it receives the
 * generated id and aria-describedby/aria-invalid wiring; the error line is announced (role=alert).
 */
export function Field({
  label,
  help,
  error,
  required,
  className,
  children
}: {
  label: React.ReactNode
  help?: React.ReactNode
  error?: React.ReactNode
  required?: boolean
  className?: string
  children: (control: { id: string; "aria-describedby"?: string; "aria-invalid"?: true; "aria-required"?: true }) => React.ReactNode
}) {
  const id = React.useId()
  const noteId = `${id}-note`
  const hasNote = Boolean(error || help)
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-[13px] font-medium text-text-bright">
        {label}
        {required && <span aria-hidden className="ml-0.5 text-state-failed">*</span>}
      </label>
      {children({ id, "aria-describedby": hasNote ? noteId : undefined, "aria-invalid": error ? true : undefined, "aria-required": required ? true : undefined })}
      {error ? (
        <p id={noteId} role="alert" className="text-[12px] leading-[1.5] text-state-failed">{error}</p>
      ) : help ? (
        <p id={noteId} className="text-[12px] leading-[1.5] text-muted-foreground">{help}</p>
      ) : null}
    </div>
  )
}
