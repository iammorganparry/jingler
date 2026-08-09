import { afterEach, describe, expect, it } from "vitest"
import { startFakeLinearServer, type FakeLinearServer } from "../../e2e/fake-linear.js"

describe("fake Linear server", () => {
  let server: FakeLinearServer | undefined

  afterEach(async () => {
    await server?.close()
  })

  it("returns 400 for malformed JSON without leaving the request pending", async () => {
    server = await startFakeLinearServer()

    const response = await fetch(server.url, {
      method: "POST",
      headers: {
        authorization: "lin_api_test",
        "content-type": "application/json"
      },
      body: "{"
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      errors: [{ message: "Invalid JSON request body" }]
    })
  })
})
