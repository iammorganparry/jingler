import { Spin } from "../components/spin.js"
import type { Environment, SshHost } from "@jingler/core"
import { Plus, RefreshCw } from "lucide-react"
import { Button } from "../components/button.js"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "../components/dialog.js"
import { Input } from "../components/input.js"

export interface EnvironmentDialogProps {
  open: boolean
  state:
    | "discovering"
    | "configuring"
    | "enrolling"
    | "connected"
    | "failed"
  values: {
    host: string
  }
  hosts: ReadonlyArray<SshHost>
  environment?: Environment | null
  error?: string | null
  onClose: () => void
  onEdit: (field: keyof EnvironmentDialogProps["values"], value: string) => void
  onSelectHost: (host: SshHost) => void
  onSubmit: () => void
  onRetry: () => void
}

export function EnvironmentDialog(props: EnvironmentDialogProps) {
  const busy = props.state === "discovering" || props.state === "enrolling"
  const valid = props.values.host.trim().length > 0
  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent className="w-[760px]">
        <DialogHeader>
          <div>
            <DialogTitle>Add owned machine</DialogTitle>
            <p className="mt-1 text-[12px] text-muted-foreground">
              Connect a remote machine through your local SSH configuration.
            </p>
          </div>
        </DialogHeader>
        <DialogBody className="space-y-5">
          {props.state === "connected" ? (
            <div
              role="status"
              className="rounded-lg border border-green/40 bg-green/10 p-4 text-[13px] text-text"
            >
              <strong>{props.environment?.name ?? "Environment"}</strong> is
              connected.
            </div>
          ) : (
            <>
              <div className="grid gap-3">
                <label className="grid gap-1.5 text-[11px] font-medium text-text">
                  <span>SSH host or alias</span>
                  <Input
                    aria-label="SSH host or alias"
                    className="h-10"
                    value={props.values.host}
                    onChange={(event) =>
                      props.onEdit("host", event.currentTarget.value)
                    }
                    placeholder="dev-machine"
                  />
                </label>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  Uses this alias exactly as your terminal does. It must connect
                  without a password; configure User and IdentityFile in
                  ~/.ssh/config when the defaults are not correct.
                </p>
                <section className="overflow-hidden rounded-lg border border-line">
                  <header className="flex items-center justify-between border-b border-hairline px-3 py-2">
                    <div>
                      <strong className="block text-[11px] text-text">
                        Suggested hosts
                      </strong>
                      <span className="text-[10px] text-muted-foreground">
                        From SSH config and known hosts
                      </span>
                    </div>
                    {props.state === "discovering" && (
                      <Spin className="text-muted-foreground">
                        <RefreshCw aria-label="Discovering hosts" size={14} />
                      </Spin>
                    )}
                  </header>
                  {props.hosts.map((host) => (
                    <button
                      key={host.alias}
                      type="button"
                      className="flex w-full items-center justify-between border-b border-hairline px-3 py-3 text-left last:border-b-0 hover:bg-surface"
                      onClick={() => props.onSelectHost(host)}
                    >
                      <span className="text-[12px] font-medium text-text">
                        {host.alias}
                      </span>
                      <span className="rounded border border-line px-2 py-1 text-[10px] text-muted-foreground">
                        {host.source === "config" ? "SSH config" : "Known host"}
                      </span>
                    </button>
                  ))}
                </section>
              </div>
              {props.error && (
                <div
                  role="alert"
                  className="rounded-md border border-red/50 bg-red/10 px-3 py-2 text-[12px] text-red"
                >
                  {props.error}
                </div>
              )}
            </>
          )}
        </DialogBody>
        {props.state !== "connected" && (
          <DialogFooter>
            {props.state === "failed" ? (
              <Button className="w-full" onClick={props.onRetry}>
                <RefreshCw size={14} /> Edit SSH host
              </Button>
            ) : (
              <Button
                className="w-full"
                aria-label="Connect environment"
                disabled={!valid || busy}
                onClick={props.onSubmit}
              >
                <Plus size={14} /> {busy ? "Connecting…" : "Add owned machine"}
              </Button>
            )}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
