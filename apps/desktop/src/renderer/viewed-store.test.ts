import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  clearViewedPaths,
  readViewedPaths,
  viewedStorageKey
} from "./viewed-store.js"

class MemoryStorage {
  private readonly values = new Map<string, string>()

  get length(): number {
    return this.values.size
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

let storage: MemoryStorage

beforeEach(() => {
  storage = new MemoryStorage()
  ;(globalThis as { localStorage?: unknown }).localStorage = storage
})

afterEach(() => {
  ;(globalThis as { localStorage?: unknown }).localStorage = undefined
})

describe("viewed paths storage", () => {
  it("migrates the legacy session key once into the active PR scope", () => {
    storage.setItem("sb.review.viewed.s1", JSON.stringify(["src/a.ts", "src/b.ts"]))

    expect([...readViewedPaths("s1", 7)]).toStrictEqual(["src/a.ts", "src/b.ts"])
    expect(storage.getItem("sb.review.viewed.s1")).toBeNull()
    expect(storage.getItem(viewedStorageKey("s1", 7))).toBe(
      JSON.stringify(["src/a.ts", "src/b.ts"])
    )
    expect([...readViewedPaths("s1", 8)]).toStrictEqual([])
  })

  it("prefers existing scoped markers over legacy data", () => {
    storage.setItem("sb.review.viewed.s1", JSON.stringify(["legacy.ts"]))
    storage.setItem(viewedStorageKey("s1", 7), JSON.stringify(["current.ts"]))

    expect([...readViewedPaths("s1", 7)]).toStrictEqual(["current.ts"])
    expect(storage.getItem("sb.review.viewed.s1")).toBeNull()
  })

  it("clears every viewed key for a deleted session only", () => {
    storage.setItem("sb.review.viewed.s1", "[]")
    storage.setItem(viewedStorageKey("s1", 7), "[]")
    storage.setItem(viewedStorageKey("s1", 8), "[]")
    storage.setItem(viewedStorageKey("s10", 7), "[]")
    storage.setItem("unrelated", "keep")

    clearViewedPaths("s1")

    expect(storage.getItem("sb.review.viewed.s1")).toBeNull()
    expect(storage.getItem(viewedStorageKey("s1", 7))).toBeNull()
    expect(storage.getItem(viewedStorageKey("s1", 8))).toBeNull()
    expect(storage.getItem(viewedStorageKey("s10", 7))).toBe("[]")
    expect(storage.getItem("unrelated")).toBe("keep")
  })
})
