import { describe, expect, it } from "vitest"
import { codexAccountIdFromAccessToken } from "./codex-access-token.js"

const token = (claims: object): string =>
  `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`

describe("Codex access token account routing", () => {
  it("reads the namespaced ChatGPT account claim", () => {
    expect(codexAccountIdFromAccessToken(token({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "00000000-0000-4000-8000-000000000001"
      }
    }))).toBe("00000000-0000-4000-8000-000000000001")
  })

  it("rejects malformed and unscoped tokens", () => {
    expect(codexAccountIdFromAccessToken("not-a-jwt")).toBeNull()
    expect(codexAccountIdFromAccessToken(token({ role: "user" }))).toBeNull()
  })
})
