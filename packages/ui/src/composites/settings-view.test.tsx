/** @vitest-environment jsdom */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { AgentEndpointCatalog, Environment } from "@jingler/core";
import { nativeCliEndpointId, ProviderId, ProviderModelId } from "@jingler/core";
import { userEvent } from "@testing-library/user-event";
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

describe("General settings · offload status", () => {
  const renderGeneral = (offloadStatus: "priming" | "ready" | "failed", onRetryOffload = vi.fn()) => {
    render(
      <SettingsView
        initialSection="general"
        githubConnection={githubDisconnected}
        offloadCompute={{ enabled: true, target: { kind: "cloud" }, explicitCommands: [] }}
        offloadStatus={offloadStatus}
        onRetryOffload={onRetryOffload}
      />,
    );
    return onRetryOffload;
  };

  it("shows Priming… and Ready labels", () => {
    renderGeneral("priming");
    expect(screen.getByText("Priming…")).toBeTruthy();
    cleanup();
    renderGeneral("ready");
    expect(screen.getByText("Ready")).toBeTruthy();
  });

  it("shows Failed · Retry and calls onRetryOffload", () => {
    const onRetryOffload = renderGeneral("failed");
    expect(screen.getByText(/Failed/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetryOffload).toHaveBeenCalledOnce();
  });
});

describe("GitHub settings", () => {
  it("persists the selected desktop harness and model for adversarial reviews", () => {
    const providerId = ProviderId.make("anthropic");
    const modelId = ProviderModelId.make("anthropic/claude-opus-4-6");
    const endpointId = nativeCliEndpointId("desktop", "claude");
    const catalog: AgentEndpointCatalog = {
      refreshedAt: "2026-09-27T00:00:00.000Z",
      stale: false,
      endpoints: [{
        endpoint: {
          id: endpointId,
          runtimeId: "claude",
          targetId: "desktop",
          label: "Claude CLI",
          status: "ready",
          version: "1.0.0",
          features: {
            steer: "none",
            planReview: false,
            subagentFleet: false,
            backgroundTasks: false,
          },
        },
        models: [{
          providerId,
          id: modelId,
          label: "Claude Opus 4.6",
          capabilities: {
            contextWindow: 1_000_000,
            reasoning: [],
            reasoningCanDisable: true,
            vision: true,
          },
          verification: "certified",
          selectable: true,
          certificationKey: "claude-opus-4-6",
          status: "ready",
        }],
      }],
    };
    const onSaveGithub = vi.fn();
    render(
      <SettingsView
        initialSection="github"
        githubConnection={githubDisconnected}
        github={{ enabled: true, autoCreatePr: false, autoDetectPr: true }}
        agentEndpointCatalog={catalog}
        onSaveGithub={onSaveGithub}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Model: Choose model" }));
    fireEvent.click(screen.getByRole("option", { name: /Claude Opus 4.6/i }));

    expect(onSaveGithub).toHaveBeenCalledWith({
      enabled: true,
      autoCreatePr: false,
      autoDetectPr: true,
      adversarialReviewModel: {
        runtimeId: "claude",
        endpointId,
        providerId,
        modelId,
      },
    });
  });
});

describe("GitHub settings · SettingsCard rows", () => {
  const githubConnected = {
    ...githubDisconnected,
    mode: "connected" as const,
    connected: true,
    user: { id: "1", login: "octocat", name: "Octo Cat", avatarUrl: null },
    installations: [{
      id: "101",
      account: { id: "2", login: "acme", type: "Organization" as const, avatarUrl: null },
      repositorySelection: "all" as const,
      permissions: {},
      status: "active" as const,
      suspendedAt: null,
    }],
  };

  it("renders connection, installations, toggles and git preference as SettingsRows", () => {
    render(
      <SettingsView
        initialSection="github"
        githubConnection={githubConnected}
        github={{ enabled: true, autoCreatePr: false, autoDetectPr: true }}
      />,
    );
    expect(screen.getByText("Connected as @octocat")).toBeTruthy();
    expect(screen.getByText("@acme")).toBeTruthy();
    expect(screen.getByText("All repositories")).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Enable pull-request features" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Open PRs whose branch is checked out elsewhere" })).toBeTruthy();
    // connection + installation + 3 PR + 2 review + 1 git
    expect(screen.getAllByTestId("settings-row")).toHaveLength(8);
  });

  it("asks for confirmation before disconnecting", () => {
    const onGithubDisconnect = vi.fn();
    render(
      <SettingsView
        initialSection="github"
        githubConnection={githubConnected}
        onGithubDisconnect={onGithubDisconnect}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(onGithubDisconnect).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onGithubDisconnect).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    fireEvent.click(
      Array.from(screen.getByRole("dialog").querySelectorAll("button")).find(
        (button) => button.textContent === "Disconnect",
      ) as HTMLElement,
    );
    expect(onGithubDisconnect).toHaveBeenCalledOnce();
    expect(dialog).toBeTruthy();
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

describe("SettingsView", () => {
  it("renders grouped navigation", () => {
    render(<SettingsView initialSection="general" githubConnection={githubDisconnected} />)
    
    // Group labels should be visible
    expect(screen.getByText("Workspace")).toBeTruthy()
    expect(screen.getByText("Agents")).toBeTruthy()
    expect(screen.getByText("Integrations")).toBeTruthy()
    expect(screen.getByText("Appearance")).toBeTruthy()
  })

  it("shows Soon pills for unready sections", () => {
    render(<SettingsView initialSection="general" githubConnection={githubDisconnected} />)
    
    // Permissions and Keybindings should show Soon pills
    const permissions = screen.getByRole("button", { name: "Permissions" })
    expect(permissions.textContent?.includes("Soon")).toBeTruthy()
    
    const keybindings = screen.getByRole("button", { name: "Keybindings" })
    expect(keybindings.textContent?.includes("Soon")).toBeTruthy()
  })

  it("filters nav items by search query", async () => {
    const user = userEvent.setup()
    render(<SettingsView initialSection="general" githubConnection={githubDisconnected} />)
    
    const searchField = screen.getByPlaceholderText("Search settings")
    
    // Initially all items are visible
    expect(screen.getByRole("button", { name: "General" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Providers" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Themes" })).toBeTruthy()
    
    // Search for "prov" should show only Providers
    await user.type(searchField, "prov")
    
    expect(screen.getByRole("button", { name: "Providers" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "General" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Themes" })).toBeNull()
  })

  it("clears search on Escape", async () => {
    const user = userEvent.setup()
    render(<SettingsView initialSection="general" githubConnection={githubDisconnected} />)
    
    const searchField = screen.getByPlaceholderText("Search settings")
    
    await user.type(searchField, "prov")
    expect(screen.queryByRole("button", { name: "General" })).toBeNull()
    
    await user.keyboard("{Escape}")
    
    // After clearing, all items should be visible again
    expect(screen.getByRole("button", { name: "General" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Providers" })).toBeTruthy()
  })

  it("hides empty groups when filtering", async () => {
    const user = userEvent.setup()
    render(<SettingsView initialSection="general" githubConnection={githubDisconnected} />)
    
    const searchField = screen.getByPlaceholderText("Search settings")
    
    // Search for "github" - only Integrations group should remain
    await user.type(searchField, "github")
    
    expect(screen.queryByText("Workspace")).toBeNull()
    expect(screen.queryByText("Agents")).toBeNull()
    expect(screen.getByText("Integrations")).toBeTruthy()
    expect(screen.queryByText("Appearance")).toBeNull()
  })
})
