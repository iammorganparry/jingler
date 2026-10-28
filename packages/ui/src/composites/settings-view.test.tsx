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
  it("renders all five connection states as neutral one-line text", () => {
    const states = ["online", "offline", "reconnecting", "incompatible", "revoked"] as const;
    const { container } = render(
      <DevicesSection
        environments={states.map((state) => ({
          ...base,
          id: `device-${state}`,
          name: `box-${state}`,
          state,
          agentVersion: "0.8",
        }))}
        loading={false}
        dialog={dialog}
        onOpen={vi.fn()}
        onRefresh={vi.fn()}
        onRename={vi.fn()}
        onRevoke={vi.fn()}
      />,
    );
    for (const label of ["Online", "Offline", "Reconnecting…", "Incompatible", "Revoked"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getByText(/Device agent v0\.8 is older than this app needs/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "How to update" })).toBeTruthy();
    expect(container.innerHTML).not.toMatch(/bg-(green|yellow|amber|red)/);
    expect(
      screen.getByText(/account-owned machines appear here automatically/i),
    ).toBeTruthy();
  });

  it("shows the update command from the device-agent README", () => {
    render(
      <DevicesSection
        environments={[{ ...base, state: "incompatible" }]}
        loading={false}
        dialog={dialog}
        onOpen={vi.fn()}
        onRefresh={vi.fn()}
        onRename={vi.fn()}
        onRevoke={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "How to update" }));
    expect(screen.getByText("pnpm --filter @jingler/device-agent build")).toBeTruthy();
  });

  it("lists running workspaces before a confirmed revoke", async () => {
    const revoke = vi.fn();
    render(
      <DevicesSection
        environments={[base]}
        workspaces={[
          { id: "s1", title: "Fix login", environmentId: "device-1" },
          { id: "s2", title: "Add search", environmentId: "device-1" },
          { id: "s3", title: "Local only" },
        ]}
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
    expect(screen.getByText("Revoke buildbox?")).toBeTruthy();
    expect(screen.getByText(/2 workspaces run on it and will stop/)).toBeTruthy();
    expect(screen.getByText("Fix login")).toBeTruthy();
    expect(screen.getByText("Add search")).toBeTruthy();
    expect(screen.queryByText("Local only")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Revoke device" }));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith("device-1"));
  });

  it("cancelling the revoke confirm leaves the device paired", () => {
    const revoke = vi.fn();
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
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(revoke).not.toHaveBeenCalled();
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

describe("SettingsView notifications", () => {
  afterEach(cleanup)

  it("warns and opens System Settings only when macOS has blocked notifications", async () => {
    const open = vi.fn()
    const { rerender } = render(
      <SettingsView initialSection="notifications" githubConnection={githubDisconnected} notificationPermission="denied" onOpenNotificationSystemSettings={open} />
    )
    expect(screen.getByText("Notifications are blocked by macOS")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Open System Settings" }))
    expect(open).toHaveBeenCalledOnce()
    rerender(<SettingsView initialSection="notifications" githubConnection={githubDisconnected} notificationPermission="unknown" onOpenNotificationSystemSettings={open} />)
    expect(screen.queryByText("Notifications are blocked by macOS")).toBeNull()
  })
})

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

  it.each(["Permissions", "Keybindings"])("opens the %s placeholder with keyboard selection", async (name) => {
    const user = userEvent.setup()
    render(<SettingsView initialSection="general" githubConnection={githubDisconnected} />)

    expect(screen.queryByRole("region", { name })).toBeNull()
    await user.tab()
    for (let i = 0; i < 40 && document.activeElement !== screen.getByRole("button", { name }); i++) await user.tab()
    expect(document.activeElement).toBe(screen.getByRole("button", { name }))
    await user.keyboard("{Enter}")

    const stub = screen.getByRole("region", { name })
    expect(stub.textContent).toContain("Coming soon")
    expect(screen.getByRole("button", { name }).getAttribute("aria-current")).toBe("true")
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

describe("Context settings · SettingsCard rows", () => {
  const context = { auto: true, budgetTokens: 300_000 };

  it("renders the thresholds as SettingsRows and persists through onSaveContext", () => {
    const onSaveContext = vi.fn();
    render(
      <SettingsView
        initialSection="context"
        githubConnection={githubDisconnected}
        context={context}
        onSaveContext={onSaveContext}
      />,
    );
    expect(screen.getAllByTestId("settings-row")).toHaveLength(2);
    expect(screen.getByText("300k tokens")).toBeTruthy();

    fireEvent.click(screen.getByRole("switch", { name: "Compact sessions automatically" }));
    expect(onSaveContext).toHaveBeenLastCalledWith({ ...context, auto: false });

    fireEvent.change(screen.getByRole("slider", { name: "Working-set budget" }), {
      target: { value: "500000" },
    });
    expect(onSaveContext).toHaveBeenLastCalledWith({ ...context, auto: false, budgetTokens: 500_000 });
  });

  it("lists live sessions as rows", () => {
    render(
      <SettingsView
        initialSection="context"
        githubConnection={githubDisconnected}
        context={context}
        contextSessions={[{
          id: "s1",
          title: "Long running session",
          snapshot: {
            sessionId: "s1", tokens: 0, window: null, budget: 300_000, triggerAt: null,
            phase: "unknown", preparing: false, digestReady: false, stalled: false,
          } as never,
        }]}
      />,
    );
    expect(screen.getByText("Your sessions right now")).toBeTruthy();
    expect(screen.getByText("Long running session")).toBeTruthy();
    expect(screen.getByText("not measurable")).toBeTruthy();
    expect(screen.getAllByTestId("settings-row")).toHaveLength(3);
  });
});

describe("Plan settings · SettingsCard rows", () => {
  it("persists plan auto-run through onSavePlanAutoRun", () => {
    const onSavePlanAutoRun = vi.fn();
    render(
      <SettingsView
        initialSection="plan"
        githubConnection={githubDisconnected}
        onSavePlanAutoRun={onSavePlanAutoRun}
      />,
    );
    const toggle = screen.getByRole("switch", { name: "Plan auto-run" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(onSavePlanAutoRun).toHaveBeenCalledWith(false);
  });

  it("saves the edited plan template through onSavePlanTemplate", async () => {
    const onSavePlanTemplate = vi.fn().mockResolvedValue(undefined);
    render(
      <SettingsView
        initialSection="plan"
        githubConnection={githubDisconnected}
        planTemplate={{ source: "" }}
        onSavePlanTemplate={onSavePlanTemplate}
      />,
    );
    expect(screen.getAllByTestId("settings-row")).toHaveLength(2);
    fireEvent.change(screen.getByRole("textbox", { name: "Plan template" }), {
      target: { value: "{}" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save template" }));
    await waitFor(() => expect(onSavePlanTemplate).toHaveBeenCalledWith({ source: "{}" }));
  });
});
