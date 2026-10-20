import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { ManagedResourceId } from "@jingler/core"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { ARCHITECTURE_ANATOMY_SKILL_BODY, EXPLAIN_SKILL_BODY } from "./builtin-skill-bodies.js"
import type { AgentResourceServiceShape } from "./agent-resource-service.js"
import { loadPortableResource, portableResourceCatalog } from "./portable-skills.js"
import { skillBody } from "./skill-metadata.js"

const repoSkill = (id: string) =>
  skillBody(readFileSync(resolve(import.meta.dirname, "../../../../../skills", id, "SKILL.md"), "utf8"))

describe("built-in skill bodies", () => {
  it.each([
    ["explain", EXPLAIN_SKILL_BODY],
    ["architecture-anatomy", ARCHITECTURE_ANATOMY_SKILL_BODY]
  ])("%s matches skills/%s/SKILL.md", (id, body) => {
    expect(body).toBe(repoSkill(id))
  })

  it("lists and loads architecture-anatomy without an operator import", async () => {
    const catalog = portableResourceCatalog([])
    expect(catalog.map(({ id }) => id)).toContain("architecture-anatomy")
    const available = new Set(catalog.map(({ id }) => id))
    const service = {} as AgentResourceServiceShape
    const loaded = await Effect.runPromise(
      loadPortableResource(service, available, ManagedResourceId.make("architecture-anatomy"))
    )
    expect(loaded).toContain("the object is the explanation")
    const explain = await Effect.runPromise(loadPortableResource(service, available, ManagedResourceId.make("explain")))
    expect(explain).toContain("architecture-anatomy")
  })
})
