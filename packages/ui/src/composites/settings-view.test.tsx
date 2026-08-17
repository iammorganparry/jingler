/** @vitest-environment jsdom */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { Environment } from "@jingler/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DevicesSection, SettingsView } from "./settings-view.js";

const base: Environment = {
  kind: "owned",
  id: "device-1",
  name: "buildbox",
  platform: { os: "darwin", arch: "arm64" },
  capabilities: {
    version: 1,
    capabilities: [],
    maxConcurrentSessions: 1,
  },
  state: "online",
  agentVersion: "1.0.0",
  lastSeenAt: 100,
};
const cloud: Environment = {
  kind: "managed",
  id: "managed_cloud_account",
  name: "Cloud",
  platform: { os: "linux", arch: "x64" },
  capabilities: {
    version: 1,
    capabilities: ["session.start"],
    maxConcurrentSessions: 1,
  },
  state: "online",
  agentVersion: null,
  lastSeenAt: null,
  region: null,
  instanceType: "basic",
  generation: 1,
  createdAt: 100,
  updatedAt: 100,
};
const dialog = {
  open: false,
  state: "configuring" as const,
  values: {
    host: "",
  },
  hosts: [],
  onClose: vi.fn(),
  onEdit: vi.fn(),
  onSelectHost: vi.fn(),
  onSubmit: vi.fn(),
  onRetry: vi.fn(),
};
afterEach(cleanup);

const githubDisconnected = {
  mode: "disconnected" as const,
  enabled: true,
  connected: false,
  user: null,
  installations: [],
  lastRefreshedAt: null,
  error: null,
};

describe("General settings", () => {
  it("defaults new chats to Auto and persists another selected mode", () => {
    const onSaveDefaultMode = vi.fn();
    render(
      <SettingsView
        githubConnection={githubDisconnected}
        onSaveDefaultMode={onSaveDefaultMode}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /General/ }));

    expect(
      screen.getByRole("tab", { name: "Auto" }).getAttribute("aria-selected"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "Ask" }));
    expect(onSaveDefaultMode).toHaveBeenCalledWith("ask");
  });
});

describe("Devices settings", () => {
  it("renders account-owned device connection and compatibility states", () => {
    render(
      <DevicesSection
        environments={[
          base,
          { ...base, id: "device-2", name: "old-mini", state: "incompatible" },
        ]}
        loading={false}
        dialog={dialog}
        onOpen={vi.fn()}
        onRefresh={vi.fn()}
        onRename={vi.fn()}
        onRevoke={vi.fn()}
      />,
    );
    expect(screen.getByText("online")).toBeTruthy();
    expect(screen.getByText("incompatible")).toBeTruthy();
    expect(
      screen.getByText(/account-owned machines appear here automatically/i),
    ).toBeTruthy();
  });
  it("confirms before revoking an environment", () => {
    const revoke = vi.fn();
    vi.spyOn(window, "confirm")
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    render(
      <DevicesSection
        environments={[base]}
        loading={false}
        dialog={dialog}
        onOpen={vi.fn()}
        onRefresh={vi.fn()}
        onRename={vi.fn()}
        onRevoke={revoke}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    expect(revoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    expect(revoke).toHaveBeenCalledWith("device-1");
  });

  it("renames an environment through the supported dialog", async () => {
    const rename = vi.fn();
    render(
      <DevicesSection
        environments={[base]}
        loading={false}
        dialog={dialog}
        onOpen={vi.fn()}
        onRefresh={vi.fn()}
        onRename={rename}
        onRevoke={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "Environment name" });
    expect((input as HTMLInputElement).value).toBe("buildbox");
    fireEvent.change(input, { target: { value: "Build mini" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));

    await waitFor(() =>
      expect(rename).toHaveBeenCalledWith("device-1", "Build mini"),
    );
  });

  it("presents Cloud as a fixed automatic execution target", () => {
    render(
      <DevicesSection
        environments={[cloud]}
        loading={false}
        dialog={dialog}
        onOpen={vi.fn()}
        onRefresh={vi.fn()}
        onRename={vi.fn()}
        onRevoke={vi.fn()}
      />,
    );

    expect(screen.getByText("Cloud", { exact: true })).toBeTruthy();
    expect(
      screen.getByText(/sandbox starts automatically per session/i),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Add cloud environment" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
  });
});
