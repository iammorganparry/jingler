// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { POSITION_POLL_MS, useNativeViewBounds, type NativeViewRect } from "./use-native-view-bounds.js"

/** A ResizeObserver stub that lets a test fire the callback by hand. */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  observed: Element[] = []
  disconnected = false
  constructor(readonly callback: () => void) {
    FakeResizeObserver.instances.push(this)
  }
  observe(el: Element) {
    this.observed.push(el)
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true
  }
}

let rect: NativeViewRect = { x: 0, y: 0, width: 0, height: 0 }
let reads = 0

function Probe({ active, onFirst, onChanged }: {
  active: boolean
  onFirst: (r: NativeViewRect) => void
  onChanged: (r: NativeViewRect) => void
}) {
  const ref = useNativeViewBounds({ active, onFirstPaintableRect: onFirst, onBoundsChanged: onChanged })
  return <div ref={ref} data-testid="placeholder" />
}

/** Fake timers + a controllable placeholder rect, torn down after each test. */
const useFakeDom = () => {
  beforeEach(() => {
    vi.useFakeTimers()
    FakeResizeObserver.instances = []
    vi.stubGlobal("ResizeObserver", FakeResizeObserver)
    rect = { x: 0, y: 0, width: 0, height: 0 }
    reads = 0
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => {
      reads += 1
      return { ...rect, top: rect.y, left: rect.x, right: rect.x + rect.width, bottom: rect.y + rect.height, toJSON: () => rect } as DOMRect
    })
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })
}

const frames = (n: number) => {
  for (let i = 0; i < n; i++) vi.advanceTimersByTime(16)
}

describe("useNativeViewBounds", () => {
  useFakeDom()

  it("settles frame by frame only until the first paintable rect, then stops polling per frame", () => {
    const onFirst = vi.fn()
    const onChanged = vi.fn()
    render(<Probe active onFirst={onFirst} onChanged={onChanged} />)

    // Placeholder is 0×0 mid-transition: the settle loop keeps reading.
    act(() => frames(3))
    expect(onFirst).not.toHaveBeenCalled()
    const readsWhileDegenerate = reads
    expect(readsWhileDegenerate).toBeGreaterThanOrEqual(3)

    rect = { x: 10, y: 20, width: 300, height: 200 }
    act(() => frames(1))
    expect(onFirst).toHaveBeenCalledTimes(1)
    expect(onChanged).toHaveBeenCalledTimes(1)
    expect(onChanged).toHaveBeenLastCalledWith(rect)

    // The per-frame loop is gone: a full second costs only the slow poll.
    const readsAfterSettle = reads
    act(() => vi.advanceTimersByTime(1000))
    expect(reads - readsAfterSettle).toBeLessThanOrEqual(Math.ceil(1000 / POSITION_POLL_MS))
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it("pushes new bounds from a ResizeObserver notification, and ignores unchanged ones", () => {
    const onChanged = vi.fn()
    rect = { x: 0, y: 0, width: 300, height: 200 }
    render(<Probe active onFirst={vi.fn()} onChanged={onChanged} />)
    act(() => frames(1))
    expect(onChanged).toHaveBeenCalledTimes(1)
    const observer = FakeResizeObserver.instances.at(-1)!
    expect(observer.observed).toHaveLength(1)

    act(() => observer.callback())
    expect(onChanged).toHaveBeenCalledTimes(1)

    rect = { x: 0, y: 0, width: 640, height: 200 }
    act(() => observer.callback())
    expect(onChanged).toHaveBeenCalledTimes(2)
    expect(onChanged).toHaveBeenLastCalledWith(rect)
  })

})

describe("useNativeViewBounds lifecycle", () => {
  useFakeDom()

  it("re-arms the first-paintable fire when active flips off and on, and tears everything down", () => {
    const onFirst = vi.fn()
    rect = { x: 0, y: 0, width: 300, height: 200 }
    const view = render(<Probe active onFirst={onFirst} onChanged={vi.fn()} />)
    act(() => frames(1))
    expect(onFirst).toHaveBeenCalledTimes(1)

    view.rerender(<Probe active={false} onFirst={onFirst} onChanged={vi.fn()} />)
    expect(FakeResizeObserver.instances.at(-1)!.disconnected).toBe(true)
    const readsWhileInactive = reads
    act(() => vi.advanceTimersByTime(POSITION_POLL_MS * 4))
    expect(reads).toBe(readsWhileInactive)

    view.rerender(<Probe active onFirst={onFirst} onChanged={vi.fn()} />)
    act(() => frames(1))
    expect(onFirst).toHaveBeenCalledTimes(2)
  })
})
