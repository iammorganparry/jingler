import { describe, expect, it } from "vitest"
import {
  FakeEmbedder,
  OpenAiEmbedder,
  createOpenAiEmbedderFromEnv,
  deterministicEmbedding,
  resolveOpenAiEmbedModel
} from "./embeddings.js"

describe("FakeEmbedder", () => {
  it("is deterministic and order-preserving", async () => {
    const embedder = new FakeEmbedder()
    const first = await embedder.embed(["alpha beta", "gamma delta"])
    const second = await embedder.embed(["alpha beta", "gamma delta"])
    expect(first).toEqual(second)
    expect(first).toHaveLength(2)
    expect(first[0]).toHaveLength(1_536)
    // Shared vocabulary lands closer in cosine space than disjoint vocabulary.
    expect(deterministicEmbedding("alpha beta", 8)).toEqual(deterministicEmbedding("alpha beta", 8))
  })
})

describe("resolveOpenAiEmbedModel", () => {
  it("defaults to text-embedding-3-small (1536 dims)", () => {
    expect(resolveOpenAiEmbedModel({})).toEqual({ model: "text-embedding-3-small", dims: 1_536 })
    expect(resolveOpenAiEmbedModel({ OPENAI_EMBED_MODEL: "" })).toEqual({
      model: "text-embedding-3-small",
      dims: 1_536
    })
  })

  it("knows text-embedding-3-large is 3072 dims", () => {
    expect(resolveOpenAiEmbedModel({ OPENAI_EMBED_MODEL: "text-embedding-3-large" }).dims).toBe(3_072)
  })
})

describe("createOpenAiEmbedderFromEnv", () => {
  it("is undefined without an API key, defined with one", () => {
    expect(createOpenAiEmbedderFromEnv({})).toBeUndefined()
    expect(createOpenAiEmbedderFromEnv({ OPENAI_API_KEY: "" })).toBeUndefined()
    expect(createOpenAiEmbedderFromEnv({ OPENAI_API_KEY: "sk-test" })).toBeDefined()
  })
})

describe("OpenAiEmbedder", () => {
  it("posts the batch and maps embeddings back by index", async () => {
    let captured: { url: string; body: unknown; authorization: string | null } | undefined
    const fakeFetch: typeof fetch = (async (url: string, init: RequestInit) => {
      captured = {
        url: String(url),
        body: JSON.parse(String(init.body)),
        authorization: new Headers(init.headers).get("authorization")
      }
      // Return embeddings out of order to prove index-based reassembly.
      return {
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              { embedding: [0.2, 0.2], index: 1 },
              { embedding: [0.1, 0.1], index: 0 }
            ]
          })
      } as Response
    }) as unknown as typeof fetch

    const embedder = new OpenAiEmbedder({ apiKey: "sk-test", fetch: fakeFetch })
    const vectors = await embedder.embed(["first", "second"])

    expect(captured?.url).toBe("https://api.openai.com/v1/embeddings")
    expect(captured?.authorization).toBe("Bearer sk-test")
    expect(captured?.body).toEqual({ model: "text-embedding-3-small", input: ["first", "second"] })
    // Reassembled by index, not response order.
    expect(vectors).toEqual([
      [0.1, 0.1],
      [0.2, 0.2]
    ])
  })

  it("throws on a non-2xx response so the caller can degrade to lexical", async () => {
    const failingFetch: typeof fetch = (async () =>
      ({ ok: false, status: 400, json: () => Promise.resolve({}) }) as Response) as unknown as typeof fetch
    const embedder = new OpenAiEmbedder({ apiKey: "sk-test", fetch: failingFetch })
    await expect(embedder.embed(["x"])).rejects.toThrow(/400/)
  })
})
