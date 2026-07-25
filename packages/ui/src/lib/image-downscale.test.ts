import { afterEach, describe, expect, it, vi } from "vitest"
import { MAX_IMAGE_EDGE, downscaleImage, fitWithin } from "./image-downscale.js"

/**
 * A stand-in for the canvas pipeline. jsdom ships neither `createImageBitmap` nor
 * `OffscreenCanvas`, which is itself a case worth pinning (the fallback must
 * return the original bytes rather than throw) — so the happy path installs both.
 */
const stubCanvas = (
  source: { width: number; height: number },
  encodedBytes: number
): { drawn: Array<readonly [number, number]> } => {
  const drawn: Array<readonly [number, number]> = []
  vi.stubGlobal("createImageBitmap", () =>
    Promise.resolve({ width: source.width, height: source.height, close: () => {} })
  )
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      constructor(
        public width: number,
        public height: number
      ) {}
      getContext() {
        return {
          drawImage: (_bitmap: unknown, _x: number, _y: number, w: number, h: number) => {
            drawn.push([w, h])
          }
        }
      }
      convertToBlob({ type }: { type: string }) {
        return Promise.resolve(new Blob([new Uint8Array(encodedBytes)], { type }))
      }
    }
  )
  return { drawn }
}

/** A blob of `bytes` length, so the "did the re-encode help?" guard has something real to compare. */
const blobOf = (bytes: number, type: string): Blob =>
  new Blob([new Uint8Array(bytes)], { type })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("fitWithin", () => {
  it("leaves an image that already fits completely untouched", () => {
    expect(fitWithin(800, 600, 1568)).toEqual({ width: 800, height: 600 })
    // Exactly on the cap is within it — an off-by-one here re-encodes every
    // screenshot from a 1568-wide capture for no gain.
    expect(fitWithin(1568, 900, 1568)).toEqual({ width: 1568, height: 900 })
  })

  it("scales the longest edge down to the cap, preserving aspect ratio", () => {
    expect(fitWithin(3010, 1882, 1568)).toEqual({ width: 1568, height: 980 })
    // Portrait: the cap applies to whichever edge is longest, not to width.
    expect(fitWithin(1000, 4000, 1568)).toEqual({ width: 392, height: 1568 })
  })

  it("never yields a zero edge, however extreme the aspect ratio", () => {
    // 4000×1 scaled by 1568/4000 rounds the height to 0 — an OffscreenCanvas of
    // height 0 has no 2D context, so this would fail at draw time.
    expect(fitWithin(4000, 1, 1568)).toEqual({ width: 1568, height: 1 })
  })

  it("treats a zero-sized image as already fitting rather than dividing by zero", () => {
    expect(fitWithin(0, 0, 1568)).toEqual({ width: 0, height: 0 })
  })
})

describe("downscaleImage", () => {
  it("re-encodes an oversized image at the capped size", async () => {
    const { drawn } = stubCanvas({ width: 3010, height: 1882 }, 200_000)
    const result = await downscaleImage(blobOf(4_000_000, "image/png"), "image/png")

    expect(drawn).toEqual([[1568, 980]])
    expect(result?.mediaType).toBe("image/png")
    expect(result?.data.length).toBeGreaterThan(0)
  })

  it("declines an image already inside the cap, so its original bytes are kept", async () => {
    stubCanvas({ width: 900, height: 600 }, 1_000)
    expect(await downscaleImage(blobOf(50_000, "image/png"), "image/png")).toBeNull()
  })

  it("declines a re-encode that came out no smaller than the original", async () => {
    // Contrived but real: a tiny source that PNG-encodes badly. The original bytes
    // are already on hand and cost less, so the resize is not worth keeping.
    stubCanvas({ width: 2000, height: 2000 }, 900_000)
    expect(await downscaleImage(blobOf(500_000, "image/png"), "image/png")).toBeNull()
  })

  it("leaves a GIF alone — a canvas round-trip would drop the animation", async () => {
    stubCanvas({ width: 3000, height: 3000 }, 1_000)
    expect(await downscaleImage(blobOf(4_000_000, "image/gif"), "image/gif")).toBeNull()
  })

  it("falls back to the original when the environment has no canvas APIs", async () => {
    // No stubs installed: `createImageBitmap` is absent, exactly as in jsdom and
    // in any future non-Chromium host. Must return null, never throw.
    expect(await downscaleImage(blobOf(4_000_000, "image/png"), "image/png")).toBeNull()
  })

  it("falls back to the original when decoding throws", async () => {
    vi.stubGlobal("createImageBitmap", () => Promise.reject(new Error("corrupt")))
    expect(await downscaleImage(blobOf(4_000_000, "image/png"), "image/png")).toBeNull()
  })

  it("caps at 1568 by default — the largest edge the vision API itself uses", () => {
    expect(MAX_IMAGE_EDGE).toBe(1568)
  })
})
