import { describe, expect, it } from "vitest"
import { FakeSubscriptionEndpoint } from "./fake-subscription.js"

describe("fake subscription endpoint", () => {
  it("validates a Claude setup-token and reports subscription entitlement", () => {
    const endpoint = new FakeSubscriptionEndpoint()
    const credential = endpoint.validateClaudeSetupToken("claude-setup-fixture")
    expect(credential.route).toBe("claude-setup-token")
    expect(endpoint.entitlement(credential)).toMatchObject({
      status: "active",
      billingRoute: "subscription"
    })
  })

  it("completes Codex device login and rotates refresh credentials", () => {
    const endpoint = new FakeSubscriptionEndpoint()
    const login = endpoint.startCodexLogin()
    expect(endpoint.pollCodexLogin(login.deviceCode)).toBeNull()
    endpoint.approveCodexLogin(login.deviceCode)
    const credential = endpoint.pollCodexLogin(login.deviceCode)
    expect(credential?.route).toBe("openai-codex-oauth")
    const rotated = endpoint.refresh(credential!)
    expect(rotated.refreshToken).not.toBe(credential?.refreshToken)
  })

  it("models revocation and unexpected API-credit requirements", () => {
    const endpoint = new FakeSubscriptionEndpoint()
    const login = endpoint.startCodexLogin()
    endpoint.approveCodexLogin(login.deviceCode)
    const credential = endpoint.pollCodexLogin(login.deviceCode)!
    expect(endpoint.entitlement(credential, "requires-api-credits")).toEqual({
      status: "requires-api-credits"
    })
    endpoint.revoke(credential)
    expect(endpoint.entitlement(credential)).toEqual({ status: "revoked" })
    expect(() => endpoint.refresh(credential)).toThrow("credential-revoked")
  })

  it("rejects invalid setup-tokens without consulting another auth route", () => {
    const endpoint = new FakeSubscriptionEndpoint()
    expect(() => endpoint.validateClaudeSetupToken("wrong-token")).toThrow("invalid-setup-token")
  })
})
