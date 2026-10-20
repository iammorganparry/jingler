import type { AuthKind, ProviderId } from "@jingler/core"
import { useMachine } from "@xstate/react"
import { useRef, useState } from "react"
import { Button } from "../components/button.js"
import { Callout } from "../components/callout.js"
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from "../components/drawer.js"
import { DeviceCodeBlock } from "../components/device-code-block.js"
import { Input } from "../components/input.js"
import { Spinner } from "../components/loading.js"
import { SegmentedControl } from "../components/segmented-control.js"
import { providerConnectionsSettingsMachine } from "./provider-connections-settings-machine.js"

export interface ConnectSheetDeviceCode {
  readonly userCode: string
  readonly verificationUri: string
  readonly expiresInSeconds: number | null
}

export interface ProviderConnectSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  providerId: ProviderId
  providerLabel: string
  busy?: boolean
  /** Set once the OAuth login starts; the sheet stays in the waiting state until this clears. */
  oauthLoginId?: string | null
  deviceCode?: ConnectSheetDeviceCode | null
  /** Starts an OAuth login (browser or device code) and resolves with the login id to track for Cancel. */
  onStartOauth: () => Promise<string>
  /** Calls the Provider.cancelLogin RPC for the in-flight login. */
  onCancelLogin: (loginId: string) => Promise<void>
  onReopenBrowser: () => void
  /** Sets and verifies the API key (Provider.setApiKey + Provider.verifyModel); resolves ok or an error message. */
  onSaveApiKey: (apiKey: string) => Promise<{ ok: true } | { ok: false; error: string }>
}

/** 480px Drawer: subscription (OAuth) vs API key, cataloged in COMPONENTS.md alongside `DeviceCodeBlock`. */
export function ProviderConnectSheet({
  open,
  onOpenChange,
  providerLabel,
  busy = false,
  deviceCode = null,
  onStartOauth,
  onCancelLogin,
  onReopenBrowser,
  onSaveApiKey
}: ProviderConnectSheetProps) {
  const [mode, setMode] = useState<"subscription" | "api-key">("subscription")
  const [state, send] = useMachine(providerConnectionsSettingsMachine, {
    input: { connectionIds: [], defaultConnectionId: null }
  })
  const apiKeyInput = useRef<HTMLInputElement>(null)
  const [saving, setSaving] = useState(false)
  const waiting = state.matches("oauthWaitingFromAdding") || state.matches("oauthWaitingFromBrowsing")

  const startOauth = async () => {
    const loginId = await onStartOauth()
    send({ type: "START_OAUTH", loginId })
  }

  const cancel = async () => {
    if (state.context.oauthLoginId) await onCancelLogin(state.context.oauthLoginId)
    send({ type: "CANCEL" })
  }

  const saveApiKey = async () => {
    const value = apiKeyInput.current?.value.trim() ?? ""
    if (!value) return
    send({ type: "SUBMIT_API_KEY", value })
    setSaving(true)
    const result = await onSaveApiKey(value)
    setSaving(false)
    if (result.ok) {
      send({ type: "API_KEY_VERIFIED" })
      onOpenChange(false)
    } else {
      send({ type: "API_KEY_INVALID", error: result.error })
    }
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent aria-label={`Connect ${providerLabel}`}>
        <div className="flex flex-col gap-4 p-5">
          <div>
            <DrawerTitle className="text-[15px] font-semibold text-text-bright">
              Connect {providerLabel}
            </DrawerTitle>
            <DrawerDescription className="mt-1 text-[11.5px] text-muted-foreground">
              Choose how Jingler should authenticate with this provider.
            </DrawerDescription>
          </div>

          <SegmentedControl
            items={[
              { value: "subscription" as const, label: "Subscription" },
              { value: "api-key" as const, label: "API key" }
            ]}
            value={mode}
            onChange={setMode}
            aria-label="Connection method"
          />

          {mode === "subscription" ? (
            waiting ? (
              <div className="flex flex-col items-center gap-4 rounded-lg border border-line bg-sunken p-4">
                {deviceCode ? (
                  <DeviceCodeBlock
                    code={deviceCode.userCode}
                    verificationUri={deviceCode.verificationUri}
                    expiresInSeconds={deviceCode.expiresInSeconds}
                    onReopenBrowser={onReopenBrowser}
                  />
                ) : (
                  <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
                    <Spinner size={13} /> Waiting for browser sign-in…
                  </div>
                )}
                <Button variant="secondary" onClick={cancel}>
                  Cancel
                </Button>
              </div>
            ) : (
              <Button variant="primary" disabled={busy} onClick={startOauth}>
                {busy && <Spinner size={13} />} Open browser
              </Button>
            )
          ) : (
            <div className="flex flex-col gap-2">
              <Input
                ref={apiKeyInput}
                type="password"
                autoComplete="off"
                placeholder="Provider API key"
                defaultValue={state.context.apiKeyValue}
                disabled={saving}
              />
              {state.context.apiKeyError && <Callout tone="red">{state.context.apiKeyError}</Callout>}
              <Button variant="primary" disabled={saving} onClick={saveApiKey}>
                {saving && <Spinner size={13} />} {saving ? "Verifying…" : "Save API key"}
              </Button>
            </div>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  )
}

export type { AuthKind }
