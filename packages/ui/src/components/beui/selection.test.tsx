import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Combobox,
  ComboboxContent,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "./combobox.js";
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

  it("uses Combobox for a searchable choice", () => {
    const onValueChange = vi.fn();
    render(
      <Combobox value="opus" onValueChange={onValueChange}>
        <ComboboxTrigger>
          <ComboboxInput aria-label="Model" />
        </ComboboxTrigger>
        <ComboboxContent>
          <ComboboxList>
            <ComboboxItem value="opus">Opus</ComboboxItem>
            <ComboboxItem value="codex">Codex</ComboboxItem>
          </ComboboxList>
        </ComboboxContent>
      </Combobox>,
    );
    const input = screen.getByRole("combobox", { name: "Model" });
    fireEvent.click(input);
    fireEvent.change(input, { target: { value: "cod" } });
    expect(screen.queryByRole("option", { name: "Opus" })).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: "Codex" }));
    expect(onValueChange).toHaveBeenCalledWith("codex");
  });
});
