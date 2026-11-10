import { describe, expect, it, vi } from "vitest"
import { trustExtraCaCerts } from "./extra-ca-certs.js"

const asIs = async (environment: NodeJS.ProcessEnv) => environment

const cert = (body: string) => `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`

describe("trustExtraCaCerts", () => {
  it("appends the bundle's new certificates to the default CA list", async () => {
    const setDefaultCACertificates = vi.fn()
    const tls = { getCACertificates: () => [cert("A")], setDefaultCACertificates }
    const count = await trustExtraCaCerts(
      { NODE_EXTRA_CA_CERTS: "/corp.pem" },
      async () => `${cert("A")}\njunk\n${cert("B")}`,
      tls,
      asIs
    )
    expect(count).toBe(2)
    expect(setDefaultCACertificates).toHaveBeenCalledWith([cert("A"), cert("B")])
  })

  it("leaves the CA list alone without a readable bundle", async () => {
    const setDefaultCACertificates = vi.fn()
    const tls = { getCACertificates: () => [], setDefaultCACertificates }
    expect(await trustExtraCaCerts({}, async () => cert("A"), tls, asIs)).toBe(0)
    expect(await trustExtraCaCerts({ NODE_EXTRA_CA_CERTS: "/gone" }, () => Promise.reject(new Error("ENOENT")), tls, asIs)).toBe(0)
    expect(setDefaultCACertificates).not.toHaveBeenCalled()
  })
})
