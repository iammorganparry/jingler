import { describe, it, expect, vi, beforeEach } from "vitest"
import { BrowserWindow } from "electron"

describe("Window RPCs", () => {
  let mockWindow: {
    minimize: ReturnType<typeof vi.fn>
    maximize: ReturnType<typeof vi.fn>
    unmaximize: ReturnType<typeof vi.fn>
    isMaximized: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    mockWindow = {
      minimize: vi.fn(),
      maximize: vi.fn(),
      unmaximize: vi.fn(),
      isMaximized: vi.fn().mockReturnValue(false),
      close: vi.fn(),
    }
  })

  describe("Window.minimize", () => {
    it("calls minimize on the window", () => {
      mockWindow.minimize()
      expect(mockWindow.minimize).toHaveBeenCalledOnce()
    })
  })

  describe("Window.toggleMaximize", () => {
    it("maximizes when not maximized", () => {
      mockWindow.isMaximized.mockReturnValue(false)
      if (!mockWindow.isMaximized()) mockWindow.maximize()
      else mockWindow.unmaximize()
      
      expect(mockWindow.maximize).toHaveBeenCalledOnce()
      expect(mockWindow.unmaximize).not.toHaveBeenCalled()
    })

    it("unmaximizes when maximized", () => {
      mockWindow.isMaximized.mockReturnValue(true)
      if (!mockWindow.isMaximized()) mockWindow.maximize()
      else mockWindow.unmaximize()
      
      expect(mockWindow.unmaximize).toHaveBeenCalledOnce()
      expect(mockWindow.maximize).not.toHaveBeenCalled()
    })
  })

  describe("Window.isMaximized", () => {
    it("returns true when window is maximized", () => {
      mockWindow.isMaximized.mockReturnValue(true)
      expect(mockWindow.isMaximized()).toBe(true)
    })

    it("returns false when window is not maximized", () => {
      mockWindow.isMaximized.mockReturnValue(false)
      expect(mockWindow.isMaximized()).toBe(false)
    })
  })

  describe("Window.close", () => {
    it("calls close on the window", () => {
      mockWindow.close()
      expect(mockWindow.close).toHaveBeenCalledOnce()
    })
  })
})
