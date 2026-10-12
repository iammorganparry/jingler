import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../components/dialog.js"
import { Markdown } from "../components/markdown.js"
import iconSrc from "../brand/assets/jingler-icon-color.png"

/** One version's release notes, as listed by the "What's new" dialog. */
export interface WhatsNewEntry {
  readonly version: string
  /** One-line changes in CHANGELOG order. */
  readonly notes: readonly string[]
}

export interface WhatsNewDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Every version to list, newest first. */
  entries: readonly WhatsNewEntry[]
}

/** Release notes for every version since the last one seen, reopenable from the account menu. */
export function WhatsNewDialog({ open, onOpenChange, entries }: WhatsNewDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader className="pr-12">
          <img src={iconSrc} alt="" className="size-7 flex-none" />
          <DialogTitle>What's new</DialogTitle>
          <DialogDescription>Changes in Jingler since you last looked.</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          {entries.length === 0 ? (
            <p className="text-[12px] text-muted-foreground">No release notes for this version.</p>
          ) : (
            entries.map((entry) => (
              <section key={entry.version} aria-label={`Jingler ${entry.version}`}>
                <h3 className="mb-1 font-mono text-[11px] font-semibold text-text-bright">v{entry.version}</h3>
                <Markdown className="text-[12px]">{entry.notes.map((note) => `- ${note}`).join("\n")}</Markdown>
              </section>
            ))
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
