import * as React from "react"
import type { Environment, SshHost } from "@jingler/core"
import { Link2, Plus, RefreshCw, Server } from "lucide-react"
import { Button } from "../components/button.js"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle
} from "../components/dialog.js"
import { cn } from "../lib/cn.js"

export interface EnvironmentDialogProps {
  open: boolean
  state:
    | "choosing"
    | "discovering"
    | "configuring"
    | "linking"
    | "claiming"
    | "connected"
    | "failed"
  method: "remote-link" | "ssh" | null
  values: {
    backendUrl: string
    pendingDeviceId: string
    pairingCode: string
    host: string
    username: string
    port: string
  }
  hosts: ReadonlyArray<SshHost>
  environment?: Environment | null
  error?: string | null
  onClose: () => void
  onChoose: (method: "remote-link" | "ssh") => void
  onEdit: (field: keyof EnvironmentDialogProps["values"], value: string) => void
  onSelectHost: (host: SshHost) => void
  onSubmit: () => void
  onRetry: () => void
}

const inputClass =
  "h-10 w-full rounded-md border border-line bg-sunken px-3 text-[12px] text-text outline-none placeholder:text-dim focus:border-blue focus:ring-2 focus:ring-blue/20"

export function EnvironmentDialog(props: EnvironmentDialogProps) {
  const busy = props.state === "discovering" || props.state === "claiming"
  const valid =
    props.method === "ssh"
      ? props.values.host.trim().length > 0
      : props.method === "remote-link" &&
        props.values.backendUrl.trim().length > 0 &&
        props.values.pendingDeviceId.trim().length > 0 &&
        props.values.pairingCode.trim().length > 0
  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent className="w-[760px]">
        <DialogHeader>
          <div>
            <DialogTitle>Add Environment</DialogTitle>
            <p className="mt-1 text-[12px] text-muted-foreground">
              Pair another environment to this client.
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
              <div className="grid grid-cols-2 gap-3">
                {(["remote-link", "ssh"] as const).map((method) => (
                  <button
                    key={method}
                    type="button"
                    onClick={() => props.onChoose(method)}
                    className={cn(
                      "flex min-h-28 items-start gap-3 rounded-lg border p-4 text-left",
                      props.method === method
                        ? "border-blue bg-blue/5"
                        : "border-line bg-canvas hover:bg-surface"
                    )}
                  >
                    <span className="rounded-md border border-line bg-sunken p-2 text-blue">
                      {method === "ssh" ? (
                        <Server size={18} />
                      ) : (
                        <Link2 size={18} />
                      )}
                    </span>
                    <span>
                      <strong className="block text-[14px] text-text-bright">
                        {method === "ssh" ? "SSH" : "Remote link"}
                      </strong>
                      <span className="mt-1 block text-[12px] leading-relaxed text-muted-foreground">
                        {method === "ssh"
                          ? "Use local SSH config, agent, and tunnels for bootstrap."
                          : "Enter a backend host and pairing code."}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
              {props.method === "remote-link" && (
                <div className="grid gap-3">
                  <label className="grid gap-1.5 text-[11px] font-medium text-text">
                    <span>Backend host</span>
                    <input
                      aria-label="Backend host"
                      className={inputClass}
                      value={props.values.backendUrl}
                      onChange={(event) =>
                        props.onEdit("backendUrl", event.currentTarget.value)
                      }
                      placeholder="https://app.jingler.dev"
                    />
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="grid gap-1.5 text-[11px] font-medium text-text">
                      <span>Device ID</span>
                      <input
                        aria-label="Device ID"
                        className={inputClass}
                        value={props.values.pendingDeviceId}
                        onChange={(event) =>
                          props.onEdit(
                            "pendingDeviceId",
                            event.currentTarget.value
                          )
                        }
                      />
                    </label>
                    <label className="grid gap-1.5 text-[11px] font-medium text-text">
                      <span>Pairing code</span>
                      <input
                        aria-label="Pairing code"
                        className={inputClass}
                        value={props.values.pairingCode}
                        onChange={(event) =>
                          props.onEdit("pairingCode", event.currentTarget.value)
                        }
                      />
                    </label>
                  </div>
                </div>
              )}
              {props.method === "ssh" && (
                <div className="grid gap-3">
                  <label className="grid gap-1.5 text-[11px] font-medium text-text">
                    <span>SSH host or alias</span>
                    <input
                      aria-label="SSH host or alias"
                      className={inputClass}
                      value={props.values.host}
                      onChange={(event) =>
                        props.onEdit("host", event.currentTarget.value)
                      }
                      placeholder="clive.local"
                    />
                  </label>
                  <div className="grid grid-cols-[1fr_120px] gap-3">
                    <label className="grid gap-1.5 text-[11px] font-medium text-text">
                      <span>Username</span>
                      <input
                        aria-label="Username"
                        className={inputClass}
                        value={props.values.username}
                        onChange={(event) =>
                          props.onEdit("username", event.currentTarget.value)
                        }
                      />
                    </label>
                    <label className="grid gap-1.5 text-[11px] font-medium text-text">
                      <span>Port</span>
                      <input
                        aria-label="Port"
                        className={inputClass}
                        value={props.values.port}
                        onChange={(event) =>
                          props.onEdit("port", event.currentTarget.value)
                        }
                      />
                    </label>
                  </div>
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
                        <RefreshCw
                          aria-label="Discovering hosts"
                          className="animate-spin text-muted-foreground"
                          size={14}
                        />
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
                          Add environment
                        </span>
                      </button>
                    ))}
                  </section>
                </div>
              )}
              {props.error && (
                <div
                  role="alert"
                  className="rounded-md border border-red/50 bg-red/10 px-3 py-2 text-[12px] text-red"
                >
                  {props.error}
                </div>
              )}
              {props.state === "failed" ? (
                <Button className="w-full" onClick={props.onRetry}>
                  <RefreshCw size={14} /> Retry
                </Button>
              ) : (
                <Button
                  className="w-full"
                  aria-label="Connect environment"
                  disabled={!valid || busy}
                  onClick={props.onSubmit}
                >
                  <Plus size={14} /> {busy ? "Connecting…" : "Add environment"}
                </Button>
              )}
            </>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
