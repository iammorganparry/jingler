---
name: apache-doris
description: Design, operate, troubleshoot, and optimize Apache Doris analytics and search systems. Use for Doris schema and table models, partitions and buckets, real-time ingestion and CDC, mutable multi-tenant CRM or HubSpot-scale data, materialized/materialised views, query tuning, inverted indexes, fuzzy and full-text search, NGram BloomFilters, VARIANT, vector search, lakehouse catalogs, security, backups, upgrades, and capacity planning. Apply version-aware correctness checks before recommending SQL or configuration.
---

# Apache Doris

Build for correct data first, measured performance second. Treat this as an engineering playbook, not a claim that every Doris feature works on every release. Use plain Markdown and SQL with any agent; no specific assistant, tool, MCP server, or runtime is required.

## Establish the actual system

Inspect the repository and deployment before asking for information already available. Record:

- Exact FE/BE versions and connector versions; integrated or decoupled storage/compute; cloud/vendor distribution. Check FE/BE inventories as well as `SELECT VERSION()`—a MySQL-compatible version string alone may not establish the Doris build.
- Data ownership and shape: tenant distribution, mutable entities versus append-only events, associations, custom properties, deletes, history, and money/time representations.
- Measured scale: rows and compressed bytes, largest tenant, ingest rows/s and bytes/s, burst multiplier, update fraction, retention, query concurrency, and p95/p99 latency.
- Guarantees: source ordering, duplicate delivery, replay horizon, freshness SLO, RPO/RTO, tenant isolation, and erasure obligations.
- Existing `SHOW CREATE TABLE`, partitions, tablets, load/job state, query plans/profiles, and resource headroom.

Do not translate “HubSpot scale” into an invented row count or hardware recommendation. If numbers are missing, state a provisional design and a benchmark that will decide it. Ask before destructive changes, expensive deployments, or unresolved product semantics.

## Select the reference

Load only the guides needed for the task; follow their official sources when exact syntax or compatibility matters.

| Task | Read |
|---|---|
| Choose deployment, check release support, understand engine/SQL limits | [Architecture and versions](references/architecture-and-versions.md) |
| Choose models, keys, updates, deletes, custom properties, associations | [Data modeling and CRM](references/modeling-and-crm.md) |
| Design retention, partition pruning, distribution, tablet sizing | [Partitions and buckets](references/partitions-and-buckets.md) |
| Implement Stream Load, Kafka/Routine Load, Flink CDC, retries, backfills | [Real-time ingestion](references/real-time-ingestion.md) |
| Select indexes; implement exact, substring, fuzzy, full-text, vector search | [Indexes and search](references/indexes-and-search.md) |
| Choose sync/async materialised views; prove refresh and rewrite behavior | [Materialized views](references/materialized-views.md) |
| Diagnose query latency, joins, statistics, memory, concurrency | [Query optimization](references/query-optimization.md) |
| Operate, secure, monitor, restore, scale, upgrade | [Operations](references/operations.md) |
| Verify correctness, failure recovery, performance, or deployment readiness | [Validation](references/validation.md) |
| Recheck evidence or audit feature/version claims | [Sources](references/sources.md) |

## Follow this workflow

1. **Establish correctness.** Choose the row identity, event identity, ordering contract, delete policy, and source-to-sink checkpoint rule. Decide whether the serving model is current state, history, or both.
2. **Design the smallest useful layout.** Separate mutable entity state from time-retained event history. Prefer Unique Key merge-on-write for mutable state. Add partitioning, indexes, denormalization, or materialized views only for an identified query or lifecycle requirement.
3. **Choose the ingestion contract.** Specify the acknowledgment point, retry identity, filtering policy, order/version handling, replay storage, and reconciliation procedure. A Doris transaction alone does not make the full upstream pipeline exactly-once.
4. **Measure and change one thing.** Capture a representative query and load baseline; inspect `EXPLAIN` and Query Profile; test pruning, joins, indexes, or views against that evidence. Include cold caches, skewed tenants, updates, and concurrent load.
5. **Verify and hand over.** Run applicable correctness and failure tests. Return exact version gates, changed DDL/configuration, measured before/after results, rollback/recovery steps, and evidence. Identify every example not executed on the target cluster.

## Never skip these checks

- **Keys define identity.** Adding a mutable timestamp, status, or owner to a Unique Key changes the identity. Partition columns must be key columns for Unique/Aggregate models; partitioning entity state by `updated_at` can preserve obsolete copies.
- **Partial writes are opt-in.** An `INSERT` listing only some columns is normally a full-row upsert, not a patch. Distinguish omitted values, explicit NULL, defaults, and unknown keys.
- **Sequence is not magic.** Use a comparable source version, not ingestion time. A row-level sequence can discard legitimate out-of-order changes to different properties. Do not infer source order from webhook arrival or Kafka offsets across partitions.
- **Deletions need replay protection.** Prove late-update behavior across compaction and restore; do not assume a physically removed row retains its highest sequence forever. Keep an appropriately retained deletion ledger or ordered source-state store when needed.
- **Small writes create maintenance work.** Tune batching and compaction together. Group Commit async acknowledgment is not query visibility or equivalent to a fully replicated committed row.
- **Feature combinations matter.** Flexible partial updates currently exclude VARIANT columns, sync MVs, and Group Commit. Do not assemble individually supported features into an unsupported table/load combination.
- **Search types differ.** Equality, token matching, substring `LIKE`, edit distance, and vector similarity are different semantics. `NGRAM_BF` does not index `NGRAM_SEARCH` scores or arbitrary typo tolerance.
- **Materialized does not mean fresh.** Prove base-table freshness, refresh completion, partition coverage, and actual optimizer rewrite. Preserve tenant keys in every serving projection.
- **Do not confuse replicas with backups or workload groups with access control.** Test restoration and tenant isolation independently.

## Version discipline

Research baseline: **2026-10-02**. Latest GitHub release observed: **4.1.4.1**. This is a dated observation, not a permanent recommendation to install that release.

The official `4.x` documentation already contains some **4.2.0-only** functions. Read the feature's version note, installed settings, and release notes—not just the URL. Recheck official docs before generating integration code or applying settings; match Flink/Spark connector and operator versions separately. Do not silently reuse 2.x or 3.x defaults for 4.x.

When documentation conflicts or omits a guarantee, state the uncertainty, check tagged implementation/release notes, and run a minimal test. Never upgrade an assumption into a production guarantee.
