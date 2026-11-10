import "@testing-library/jest-dom/vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ProviderId } from "@jingler/core"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ProviderAccountsCard } from "./provider-accounts-card.js"

afterEach(cleanup)

describe("ProviderAccountsCard", () => {
  it("stars the default account and offers Make default only on the others", async () => {
    const user = userEvent.setup()
    const onMakeDefault = vi.fn()
    const onSignOut = vi.fn()
    render(
      <ProviderAccountsCard
        providerId={ProviderId.make("anthropic")}
        name="Claude Code"
        status="ready"
        detail="2 accounts · subscription"
        accounts={[
          { id: "work", label: "morgan@trigify.io", plan: "Max" },
          { id: "personal", label: "morgan@personal.dev", plan: "Pro" }
        ]}
        defaultAccountId="work"
        onMakeDefault={onMakeDefault}
        onSignOut={onSignOut}
      />
    )

    expect(screen.getByLabelText("Default account")).toBeInTheDocument()
    expect(screen.getByText("Default · Max")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "morgan@trigify.io actions" }))
    expect(screen.queryByRole("menuitem", { name: "Make default" })).not.toBeInTheDocument()
    await user.keyboard("{Escape}")

    await user.click(screen.getByRole("button", { name: "morgan@personal.dev actions" }))
    await user.click(await screen.findByRole("menuitem", { name: "Make default" }))
    expect(onMakeDefault).toHaveBeenCalledWith("personal")
  })
})
