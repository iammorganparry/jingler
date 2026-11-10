import { readFile } from "node:fs/promises"
import { getCACertificates, setDefaultCACertificates } from "node:tls"
import { withLoginShellNetwork } from "@jingler/cli-adapters"

const PEM = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g

/**
 * Trust the operator's NODE_EXTRA_CA_CERTS in main-process fetch (MCP OAuth, Test connections).
 * Node reads that variable only at startup, and a Dock launch never sees the shell export.
 */
export const trustExtraCaCerts = async (
  environment: NodeJS.ProcessEnv = process.env,
  read: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
  tls = { getCACertificates, setDefaultCACertificates },
  fillNetwork: (environment: NodeJS.ProcessEnv) => Promise<NodeJS.ProcessEnv> = withLoginShellNetwork
): Promise<number> => {
  const file = (await fillNetwork(environment)).NODE_EXTRA_CA_CERTS
  if (file === undefined) return 0
  const extra = (await read(file).catch(() => "")).match(PEM) ?? []
  if (extra.length === 0) return 0
  const current = tls.getCACertificates("default")
  tls.setDefaultCACertificates([...current, ...extra.filter((cert) => !current.includes(cert))])
  return extra.length
}
