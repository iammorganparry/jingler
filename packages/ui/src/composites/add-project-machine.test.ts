import type { Project } from "@jingler/core"
import { createActor, waitFor } from "xstate"
import { describe, expect, it, vi } from "vitest"
import { addProjectMachine, repositoryNameFromUrl } from "./add-project-machine.js"

const project: Project = {
  id: "p-1",
  name: "jingler",
  path: "/repos/jingler",
  availability: "available",
  createdAt: "2026-08-09T00:00:00.000Z",
  updatedAt: "2026-08-09T00:00:00.000Z"
}

describe("addProjectMachine", () => {
  it("opens Finder from the existing local repository flow", async () => {
    const register = vi.fn(async () => project)
    const added = vi.fn()
    const actor = createActor(addProjectMachine, {
      input: {
        getDeps: () => ({
          browse: async () => "/repos/jingler",
          browseCloneDestination: async () => null,
          listDirectories: async () => ({ path: "/repos", parentPath: "/", directories: [] }),
          listGitHubRepositories: async () => [],
          register,
          createDirectory: async () => project,
          clone: async () => project,
          cloneFromGitHub: async () => project,
          onAdded: added,
          onClose: vi.fn()
        })
      }
    }).start()

    actor.send({ type: "OPEN" })
    actor.send({ type: "SELECT", method: "existing" })
    await waitFor(actor, (snapshot) => snapshot.matches("directory"))
    actor.send({ type: "BROWSE" })
    expect(actor.getSnapshot().context.method).toBe("existing")
    await waitFor(actor, (snapshot) => snapshot.matches("form"))
    actor.send({ type: "SUBMIT" })
    await waitFor(actor, (snapshot) => snapshot.matches("closed"))

    expect(register).toHaveBeenCalledWith({ path: "/repos/jingler" })
    expect(added).toHaveBeenCalledWith(project)
  })
})

describe("addProjectMachine directory browser", () => {
  it("navigates the in-app directory browser before registering a project", async () => {
    const register = vi.fn(async () => project)
    const listDirectories = vi.fn(async (path?: string) => ({
      path: path ?? "/repos",
      parentPath: "/",
      directories: []
    }))
    const actor = createActor(addProjectMachine, {
      input: {
        getDeps: () => ({
          browse: async () => null,
          browseCloneDestination: async () => null,
          listDirectories,
          listGitHubRepositories: async () => [],
          register,
          createDirectory: async () => project,
          clone: async () => project,
          cloneFromGitHub: async () => project,
          onAdded: vi.fn(),
          onClose: vi.fn()
        })
      }
    }).start()

    actor.send({ type: "OPEN" })
    actor.send({ type: "SELECT", method: "existing" })
    await waitFor(actor, (snapshot) => snapshot.matches("directory"))
    actor.send({ type: "OPEN_DIRECTORY", path: "/repos/jingler" })
    await waitFor(actor, (snapshot) => snapshot.matches("directory"))
    actor.send({ type: "CHOOSE_DIRECTORY", path: "/repos/jingler" })
    actor.send({ type: "SUBMIT" })
    await waitFor(actor, (snapshot) => snapshot.matches("closed"))

    expect(listDirectories).toHaveBeenNthCalledWith(1, undefined)
    expect(listDirectories).toHaveBeenNthCalledWith(2, "/repos/jingler")
    expect(register).toHaveBeenCalledWith({ path: "/repos/jingler" })
  })
})

describe("addProjectMachine remote clone", () => {
  it("derives a destination name from HTTPS and SSH URLs", () => {
    expect(repositoryNameFromUrl("https://github.com/acme/widget.git")).toBe("widget")
    expect(repositoryNameFromUrl("git@github.com:acme/widget.git")).toBe("widget")
  })

  it("browses a destination and clones an arbitrary Git URL", async () => {
    const clone = vi.fn(async () => project)
    const actor = createActor(addProjectMachine, {
      input: {
        getDeps: () => ({
          browse: async () => null,
          browseCloneDestination: async () => "/repos/widget",
          listDirectories: async () => ({ path: "/repos", parentPath: "/", directories: [] }),
          listGitHubRepositories: async () => [],
          register: async () => project,
          createDirectory: async () => project,
          clone,
          cloneFromGitHub: async () => project,
          onAdded: vi.fn(),
          onClose: vi.fn()
        })
      }
    }).start()

    actor.send({ type: "OPEN" })
    actor.send({ type: "SELECT", method: "clone" })
    await waitFor(actor, (snapshot) => snapshot.matches("githubRepositories"))
    actor.send({ type: "SET_REMOTE_URL", url: "git@github.com:acme/widget.git" })
    actor.send({ type: "SELECT_REMOTE_URL" })
    await waitFor(actor, (snapshot) => snapshot.matches("cloneReady"))
    actor.send({ type: "SUBMIT" })
    await waitFor(actor, (snapshot) => snapshot.matches("closed"))

    expect(clone).toHaveBeenCalledWith({
      url: "git@github.com:acme/widget.git",
      destination: "/repos/widget"
    })
  })
})

describe("addProjectMachine GitHub clone", () => {
  it("loads installation repositories, chooses a clone destination, and clones with identity", async () => {
    const repository = {
      installationId: "101",
      repositoryId: "301",
      fullName: "acme/widget"
    }
    const cloneFromGitHub = vi.fn(async () => project)
    const actor = createActor(addProjectMachine, {
      input: {
        getDeps: () => ({
          browse: async () => null,
          browseCloneDestination: async () => "/repos/widget",
          listDirectories: async () => ({ path: "/repos", parentPath: "/", directories: [] }),
          listGitHubRepositories: async () => [repository],
          register: async () => project,
          createDirectory: async () => project,
          clone: async () => project,
          cloneFromGitHub,
          onAdded: vi.fn(),
          onClose: vi.fn()
        })
      }
    }).start()

    actor.send({ type: "OPEN" })
    actor.send({ type: "SELECT", method: "clone" })
    await waitFor(actor, (snapshot) => snapshot.matches("githubRepositories"))
    actor.send({ type: "SELECT_GITHUB_REPOSITORY", repository })
    await waitFor(actor, (snapshot) => snapshot.matches("cloneReady"))
    actor.send({ type: "SUBMIT" })
    await waitFor(actor, (snapshot) => snapshot.matches("closed"))

    expect(cloneFromGitHub).toHaveBeenCalledWith({
      installationId: "101",
      repository: "acme/widget",
      destination: "/repos/widget"
    })
  })
})
