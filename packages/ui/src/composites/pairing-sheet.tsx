import { Spin } from "../components/spin.js"
import type { Environment, SshHost } from "@jingler/core"
import { Check, Plus, RefreshCw, X } from "lucide-react"
import { Button } from "../components/button.js"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerTitle
} from "../components/drawer.js"
import { Input } from "../components/input.js"
import { cn } from "../lib/cn.js"

export interface PairingSheetProps {
  open: boolean
  state: "discovering" | "configuring" | "enrolling" | "connected" | "failed"
  values: { host: string }
  hosts: ReadonlyArray<SshHost>
  environment?: Environment | null
  error?: string | null
  onClose: () => void
  onEdit: (field: keyof PairingSheetProps["values"], value: string) => void
  onSelectHost: (host: SshHost) => void
  onSubmit: () => void
  /** Resumes from the failed step; the caller re-submits the same host. */
  onRetry: () => void
}

/**
 * The wizard has one bootstrap step today ("Installing device agent…"). When
 * the pairing RPC returns richer per-step progress, split this into a list.
 */
function BootstrapStep({
  state
}: {
  state: "pending" | "active" | "done" | "failed"
}) {
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-line px-3 py-3 text-[12px]">
      <span
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-full",
          state === "done" && "bg-green/15 text-green",
          state === "failed" && "bg-red/15 text-red",
          state === "active" && "bg-blue/15 text-blue",
          state === "pending" && "bg-sunken text-muted-foreground"
        )}
      >
        {state === "done" && <Check size={13} />}
        {state === "failed" && <X size={13} />}
        {state === "active" && (
          <Spin>
            <RefreshCw size={12} />
          </Spin>
        )}
      </span>
      <span className="text-text">
        {state === "done" ? "Paired" : "Installing device agent…"}
      </span>
    </div>
  )
}

/**
 * 480px right sheet (Drawer) for pairing an owned machine: host + suggestions
 * -> installing step -> Paired, or the failing step with its error as a log
 * tail and Retry. Retry re-submits the same host from the Drawer's caller.
 */
export function PairingSheet(props: PairingSheetProps) {
  const busy = props.state === "discovering" || props.state === "enrolling"
  const valid = props.values.host.trim().length > 0
  const stepState =
    props.state === "connected"
      ? "done"
      : props.state === "failed"
        ? "failed"
        : props.state === "enrolling"
          ? "active"
          : "pending"

  return (
    <Drawer open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <DrawerContent aria-label="Pair a machine">
        <div className="flex flex-col gap-5 overflow-auto p-5 pt-12">
          <div>
            <DrawerTitle className="text-[15px] font-semibold text-text-bright">
              Pair a machine
            </DrawerTitle>
            <DrawerDescription className="mt-1 text-[12px] text-muted-foreground">
              Connect a remote machine through your local SSH configuration.
            </DrawerDescription>
          </div>

          {(props.state === "discovering" || props.state === "configuring") && (
            <div className="flex flex-col gap-3">
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
              <Button
                aria-label="Connect environment"
                disabled={!valid || busy}
                onClick={props.onSubmit}
              >
                <Plus size={14} /> {busy ? "Connecting…" : "Pair this host"}
              </Button>
            </div>
          )}

          {(props.state === "enrolling" ||
            props.state === "connected" ||
            props.state === "failed") && (
            <div className="flex flex-col gap-3">
              <BootstrapStep state={stepState} />
              {props.state === "connected" && (
                <div
                  role="status"
                  className="rounded-lg border border-green/40 bg-green/10 p-4 text-[13px] text-text"
                >
                  <strong>{props.environment?.name ?? "Device"}</strong> paired
                  ✓
                </div>
              )}
              {props.state === "failed" && (
                <>
                  <pre
                    role="alert"
                    className="max-h-40 overflow-auto rounded-md border border-red/50 bg-sunken p-3 font-mono text-[11px] leading-relaxed text-red"
                  >
                    {props.error ?? "Could not connect this environment."}
                  </pre>
                  <Button className="w-full" onClick={props.onRetry}>
                    <RefreshCw size={14} /> Retry
                  </Button>
                </>
              )}
            </div>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  )
}
