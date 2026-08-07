import { describe, expect, it } from "vitest";
import { applyRelayHealthUpdate, type RelayHealthState } from "./github-relay-health.js";

describe("relay health status", () => {
  it("preserves a concrete error while reconnecting and clears it after recovery", () => {
    const statuses = new Map<string, RelayHealthState>();

    applyRelayHealthUpdate(statuses, "relay-a", {
      mode: "error",
      error: "Exceeded allowed rows read",
    });
    applyRelayHealthUpdate(statuses, "relay-a", { mode: "reconnecting" });
    expect(statuses.get("relay-a")).toEqual({
      mode: "reconnecting",
      error: "Exceeded allowed rows read",
    });

    applyRelayHealthUpdate(statuses, "relay-a", { mode: "connected" });
    expect(statuses.get("relay-a")).toEqual({ mode: "connected", error: null });
  });

  it("removes stopped relay sessions", () => {
    const statuses = new Map<string, RelayHealthState>([
      ["relay-a", { mode: "connected", error: null }],
    ]);
    applyRelayHealthUpdate(statuses, "relay-a", { mode: "stopped" });
    expect(statuses.has("relay-a")).toBe(false);
  });
});
