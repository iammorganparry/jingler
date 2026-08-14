/** Strip trailing slashes so joining a known MCP/API path never doubles them. */
export const normalizeEndpoint = (endpoint: string): string =>
  endpoint.replace(/\/+$/, "")
