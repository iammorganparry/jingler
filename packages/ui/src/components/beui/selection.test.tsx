import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSearch,
  SelectTrigger,
} from "./select.js";

afterEach(cleanup);

describe("BeUI production selection primitives", () => {
  it("uses Select for a non-search choice", () => {
    const onValueChange = vi.fn();
    render(
      <Select value="ask" onValueChange={onValueChange}>
        <SelectTrigger ariaLabel="Permission mode">Ask</SelectTrigger>
        <SelectContent search={<SelectSearch aria-label="Filter modes" />}>
          <SelectItem value="ask">Ask</SelectItem>
          <SelectItem value="auto">Auto</SelectItem>
        </SelectContent>
      </Select>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Permission mode" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Filter modes" }), {
      target: { value: "aut" },
    });
    expect(screen.queryByRole("option", { name: "Ask" })).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: "Auto" }));
    expect(onValueChange).toHaveBeenCalledWith("auto");
  });

  it("moves keyboard focus through listbox options and restores the trigger", async () => {
    render(
      <Select value="ask">
        <SelectTrigger ariaLabel="Permission mode">Ask</SelectTrigger>
        <SelectContent>
          <SelectItem value="ask">Ask</SelectItem>
          <SelectItem value="auto">Auto</SelectItem>
        </SelectContent>
      </Select>,
    );

    const trigger = screen.getByRole("button", { name: "Permission mode" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(document.activeElement).toBe(screen.getByRole("option", { name: "Ask" }));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("option", { name: "Auto" }));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(document.activeElement).toBe(trigger);
  });

  it("shows a fixed-top Select immediately on activation", () => {
    render(
      <Select value="ask" placement="top">
        <SelectTrigger ariaLabel="Permission mode">Ask</SelectTrigger>
        <SelectContent>
          <SelectItem value="ask">Ask</SelectItem>
          <SelectItem value="auto">Auto</SelectItem>
        </SelectContent>
      </Select>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Permission mode" }));
    const surface = document.querySelector<HTMLElement>('[data-side="top"]');
    expect(surface?.getAttribute("aria-hidden")).toBe("false");
    expect(surface?.style.display).not.toBe("none");
  });
});
