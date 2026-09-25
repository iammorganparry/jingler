// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ProviderConnectionId, type Environment } from "@jingler/core"
import type { ReactNode } from "react"
import { afterEach, expect, it, vi } from "vitest"
import { rpc } from "./rpc-client.js"
import { useProviderCatalog } from "./use-provider-catalog.js"

vi.mock("./rpc-client.js", () => ({ rpc: {
  providerList: vi.fn().mockResolvedValue({ connections: [] }),
  agentEndpointList: vi.fn().mockResolvedValue({ endpoints: [], refreshedAt: "initial", stale: false }),
  providerRefresh: vi.fn().mockResolvedValue(undefined),
  agentEndpointRefresh: vi.fn().mockResolvedValue(undefined),
  environmentsDiscovery: vi.fn()
} }))
afterEach(() => { cleanup(); vi.clearAllMocks() })

it("checks each target's auth status and replaces its catalog after refresh", async () => {
  const environment: Environment = {
    kind: "owned", id: "device-one", name: "Remote", platform: { os: "linux", arch: "x64" },
    state: "online", agentVersion: "1", lastSeenAt: null,
    capabilities: { version: 1, capabilities: [], maxConcurrentSessions: 1, runtime: {
      targetId: "target-one", toolIds: [], resourceIds: [],
      versions: { behavior: "1", authentication: "1", prompt: "1", tools: "1", diff: "1", policy: "1", capabilities: "1", piSdk: "1" }
    } }
  }
  vi.mocked(rpc.environmentsDiscovery).mockImplementation(async (deviceId, request) => ({
    version: 1, deviceId, updatedAt: 100,
    discovery: { version: 1, agentVersion: "1", platform: environment.platform, repositories: [],
      capabilities: { version: 1, capabilities: [], maxConcurrentSessions: 1,
        endpointCatalog: { endpoints: [], refreshedAt: request!.action, stale: false } }
    }
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  const { result, rerender } = renderHook(({ environments }) => useProviderCatalog(environments), {
    wrapper, initialProps: { environments: [environment] }
  })
  await waitFor(() => expect(result.current.remoteCatalogs[0]?.catalog?.refreshedAt).toBe("auth-status"))
  expect(rpc.environmentsDiscovery).toHaveBeenCalledWith("device-one", { targetId: "target-one", action: "auth-status" })
  act(() => result.current.refresh(ProviderConnectionId.make("local")))
  await waitFor(() => expect(result.current.remoteCatalogs[0]?.catalog?.refreshedAt).toBe("refresh"))
  expect(rpc.environmentsDiscovery).toHaveBeenCalledWith("device-one", { targetId: "target-one", action: "refresh" })
  rerender({ environments: [{ ...environment, id: "device-two", capabilities: { ...environment.capabilities, runtime: { ...environment.capabilities.runtime!, targetId: "target-two" } } }] })
  await waitFor(() => expect(rpc.environmentsDiscovery).toHaveBeenCalledWith("device-two", { targetId: "target-two", action: "auth-status" }))
  expect(result.current.remoteCatalogs[0]?.deviceId).toBe("device-two")
  client.clear()
})
