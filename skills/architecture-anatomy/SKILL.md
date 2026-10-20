---
name: architecture-anatomy
description: Draw a software system as an isometric bench of real parts (stores, queues, services, gateways) in the Explanation or Plan view. Use for any request to show, visualise, or explain how a system, service, request path, or proposed architecture fits together.
---

Adapted from Anatomy (skills.wheresryan.sh/anatomy). Its one rule carries over: **the object is the explanation.** The figure is a bench of solid parts, so a store looks like stacked platters, a queue like a conveyor of trays, and a gateway like an arch. Parts sit on layer plinths and connect through wires that end on real ports. You send a typed model and Jingler draws it. Never write SVG or HTML.

## Order of work

1. **Truth first.** Read the repo before you draw anything. Every component must be a real thing: a package, a process, a table, a queue, or a third-party API, named the way the code names it. If you can't point to it in the code or the plan, don't draw it.
2. **Pick the subject.** Choose the one part the explanation is about and set it as `lit`. Then write one sentence covering what flows, where, and what that flow means. If you can't write that sentence, you've picked the wrong figure.
3. **List the parts before the layout.** Pick 3–12 components. Fewer is clearer, and anything past 12 belongs in a second figure. Give each one the `shape` that matches what it actually does:
   - `client`: a UI, CLI, or device that starts requests
   - `gateway`: an edge, router, load balancer, or auth proxy
   - `service`: a request/response process
   - `worker`: a background or scheduled consumer
   - `queue`: a stream, topic, job queue, or event bus
   - `store`: a database or durable storage
   - `cache`: an in-memory or derived store
   - `external`: a third-party API outside your control
4. **Layers run back to front, in request order.** List them from the far edge to the near edge, for example `edge → app → data`. Each component sits on exactly one layer. Use at most 6 layers.
5. **Lines resolve.** Every link connects two real components. Set `mode` to `sync` for a request/response call, `async` for fire-and-forget or events, and `data` for reads and writes to a store. Keep `label` short, like a verb or a route (`POST /orders`, `publish`, `INSERT`).
6. **Put words in `detail`, not the drawing.** Labels are cut to 13 characters on the plinth. Versions, replica counts and why-it-matters go in `detail`, which shows in the readout when the part is focused.
7. **Critic pass.** Re-read the figure against the code. Check for any part that doesn't exist yet, any missing hop, a wrong direction, or a wrong `lit`. Fix it before you publish.

## Explanation view

Put the block in a section of `jingler_publish_explanation`, with a short prose block beside it that says the one-sentence flow:

```json
{
  "kind": "architecture",
  "id": "checkout",
  "title": "Checkout request path",
  "layers": [{ "id": "edge", "label": "Edge" }, { "id": "app", "label": "App" }, { "id": "data", "label": "Data" }],
  "components": [
    { "id": "gw", "label": "API gateway", "layer": "edge", "shape": "gateway" },
    { "id": "api", "label": "orders-api", "layer": "app", "shape": "service", "detail": "Hono, 3 replicas" },
    { "id": "q", "label": "order-events", "layer": "app", "shape": "queue" },
    { "id": "db", "label": "Postgres", "layer": "data", "shape": "store" }
  ],
  "links": [
    { "from": "gw", "to": "api", "label": "POST /orders", "mode": "sync" },
    { "from": "api", "to": "q", "label": "publish", "mode": "async" },
    { "from": "api", "to": "db", "label": "INSERT", "mode": "data" }
  ],
  "lit": "api"
}
```

## Plan view

In a plan Markdown file, write the same object without `kind` and `id` inside an `architecture` fence in the plan overview, before the first `##` heading. In plans without `<!-- id: -->` tagged stages every `##` heading is a stage, and fences inside stages are dropped:

````markdown
```architecture
{ "title": "After this change", "layers": [...], "components": [...], "links": [...], "lit": "api" }
```
````

If the fence holds invalid JSON or references unknown ids, it shows as a plain code block, so check ids before you submit. To show a proposed change, draw the system *after* the change and light the new or changed part.

## Limits

Each figure can have up to 6 layers, 24 components and 40 links. Ids must be unique, every `layer`, `from`, `to` and `lit` must point at a declared id, and a link can't point at its own source. A layer wraps onto extra rows after 6 parts. There's no explode view, drag, or before/after diff yet; for a before/after comparison, publish two figures.
