import type { ProviderLoginEvent } from "@jingler/core"
import {
  type ConnectSheetDeviceCode,
  type LoginMethod,
  type ProviderConnectRequest,
  ProviderConnectSheet,
  type SaveApiKeyResult
} from "@jingler/ui"
import { useQueryClient } from "@tanstack/react-query"
import { useCallback, useEffect, useRef, useState } from "react"
import { rpc } from "./rpc-client.js"

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const loginUrl = (event: ProviderLoginEvent): string | null =>
  event.type === "auth-url" ? event.url : event.type === "device-code" ? event.verificationUri : null

/**
 * The one connect sheet (boards 15a–15c) for settings, onboarding and chat recovery: owns the
 * provider RPCs and the login-event stream for the request's connection id.
 */
export function useProviderConnect(onConnected?: () => void) {
  const queryClient = useQueryClient()
  const [request, setRequest] = useState<ProviderConnectRequest | null>(null)
  const [open, setOpen] = useState(false)
  const [deviceCode, setDeviceCode] = useState<ConnectSheetDeviceCode | null>(null)
  const reopenUrl = useRef<string | null>(null)
  const connectedRef = useRef(onConnected)
  connectedRef.current = onConnected
  const connectionId = open ? request?.connectionId : undefined

  useEffect(() => {
    setDeviceCode(null)
    reopenUrl.current = null
    if (!connectionId) return
    return rpc.providerLoginEvents((event) => {
      if (event.connectionId !== connectionId) return
      reopenUrl.current = loginUrl(event) ?? reopenUrl.current
      if (event.type === "device-code") {
        setDeviceCode({
          userCode: event.userCode,
          verificationUri: event.verificationUri,
          expiresInSeconds: event.expiresInSeconds
        })
      }
    })
  }, [connectionId])

  const refreshCatalog = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["provider-catalog"] }),
      queryClient.invalidateQueries({ queryKey: ["agent-endpoint-catalog"] })
    ])

  const startLogin = async (method: LoginMethod) => {
    if (!request) return
    const id = request.connectionId
    try {
      if (method === "claude-cli") {
        // Marker only: the Claude CLI relay owns authentication, Jingler never reads its credentials.
        await rpc.providerConnectClaudeToken({ id, token: "claude-cli", targetId: "desktop" })
      } else {
        await rpc.providerStartCodexLogin({ id, targetId: "desktop", method })
      }
    } finally {
      setDeviceCode(null)
      await refreshCatalog()
    }
  }

  const saveApiKey = async (providerId: string, apiKey: string): Promise<SaveApiKeyResult> => {
    if (!request) return { ok: false, error: "No connection selected" }
    const id = request.connectionId
    try {
      await rpc.providerSetApiKey({ id, providerId, apiKey, targetId: "desktop" })
      const catalog = await rpc.providerList()
      const modelId = catalog.connections
        .find(({ connection }) => connection.id === id)
        ?.models.find(({ selectable }) => selectable)?.id
      if (modelId) await rpc.providerVerifyModel(id, modelId)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    } finally {
      await refreshCatalog()
    }
  }

  const connect = useCallback((next: ProviderConnectRequest) => {
    setRequest(next)
    setOpen(true)
  }, [])

  const sheet = request ? (
    <ProviderConnectSheet
      open={open}
      onOpenChange={setOpen}
      request={request}
      deviceCode={deviceCode}
      onStartLogin={startLogin}
      onCancelLogin={async () => {
        await rpc.providerCancelLogin(request.connectionId)
        await refreshCatalog()
      }}
      onReopenBrowser={() => {
        if (reopenUrl.current) void window.jingler.openExternal(reopenUrl.current)
      }}
      onSaveApiKey={saveApiKey}
      onConnected={() => connectedRef.current?.()}
    />
  ) : null

  return { connect, sheet }
}
