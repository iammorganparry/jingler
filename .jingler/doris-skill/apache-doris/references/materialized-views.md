# Materialized views: freshness, rewrites, and cost

## Contents

- Choose the view type
- Synchronous MVs
- Asynchronous MVs
- Partition-aware refresh
- Transparent rewrite
- CRM aggregation gotchas
- Validation and recovery

## Choose the view type

| Choice | Maintenance | Query behavior | Best fit |
|---|---|---|---|
| Ordinary view | No stored result | Execute its query | Reusable SQL, not a performance guarantee |
| Synchronous MV / rollup | Maintained with base-table writes after initial build | Optimizer selects it; not directly queried as a normal independent table | Supported single-table projections/aggregations requiring write-consistent results |
| Asynchronous MV / MTMV | Refresh task computes stored results | Direct query or eligible transparent rewrite | Repeated joins/aggregations, lakehouse acceleration, accepted freshness delay |
| Explicit serving table | Application/job controls incremental logic | Query the table | Bespoke state/version semantics unsupported by an MV |

Do not default to a materialized view before examining query profile, data grain, and freshness requirements. It adds storage, refresh/write cost, failure states, and optimizer work.

## Synchronous MVs

The checked guide documents single-table SELECTs, no JOIN/HAVING/LIMIT/LATERAL VIEW, and restrictions on expressions, types, and aggregate placement. On Unique Key tables, sync MVs can change column order but **cannot perform aggregation**. Current partial-update docs exclude tables with sync MVs.

Consequently, “Unique MoW + flexible property patches + synchronous aggregated CRM dashboard” is not a valid off-the-shelf combination. Use a supported async aggregation, an independently maintained fact/serving table, or revise ingestion requirements.

Initial MV creation runs asynchronously even though subsequent maintenance is synchronous. Observe `SHOW ALTER TABLE MATERIALIZED VIEW FROM database_name` and wait for completion before testing. Query the base table and inspect `EXPLAIN` to prove the MV/index was selected; do not issue a direct SELECT against a sync MV as if it were an MTMV.

Illustrative aggregation for a suitable Duplicate fact table:

```sql
CREATE MATERIALIZED VIEW sales_by_tenant_stage AS
SELECT tenant_id AS tenant_id_mv,
       stage AS stage_mv,
       SUM(amount) AS amount_sum
FROM sales_facts
GROUP BY tenant_id, stage;
```

Confirm eligibility, naming, aggregate types, delete behavior, and model-specific restrictions on the actual release. Use an alias policy compatible with the documented naming constraints. Benchmark load amplification and remove unused views.

## Asynchronous MVs

MTMVs can precompute joins and aggregations, but are **eventually consistent**. Distinguish build timing from refresh method and trigger:

- Initial build: immediate or deferred as supported.
- Refresh method: full recomputation or eligible partition-based refresh.
- Trigger: manual, scheduled, or supported commit-triggered refresh.

Do not equate partition-incremental refresh with row-by-row streaming incremental maintenance. The checked overview describes refresh through INSERT OVERWRITE. Determine how much data each change invalidates.

Illustrative manual-refresh MV; tune bucket count/replication and confirm syntax on the target cluster:

```sql
CREATE MATERIALIZED VIEW crm_pipeline_summary
BUILD IMMEDIATE REFRESH AUTO ON MANUAL
DISTRIBUTED BY HASH(tenant_id) BUCKETS 8
AS
SELECT tenant_id, pipeline_id, stage_id,
       COUNT(*) AS deal_count,
       SUM(amount) AS total_amount
FROM deals_current
GROUP BY tenant_id, pipeline_id, stage_id;

REFRESH MATERIALIZED VIEW crm_pipeline_summary AUTO;
```

A successful refresh submission is not refresh completion. Inspect MTMV metadata and task/job state using the release's documented commands/system tables. Track last successful refresh, duration, failure reason, queued/running tasks, and partition freshness. Expose freshness to consumers where required.

## Partition-aware refresh

Align MV partitioning with a supported base-table partition expression and refresh grain. Daily facts can often refresh changed days; a heavily updated nonpartitioned current-state table may invalidate all MV partitions. The checked guide explicitly warns that a changing referenced nonpartitioned table can invalidate the entire partitioned MV.

For CRM dimension joins, a company owner/region change may affect years of facts. Do not assume only today's partition changes. Decide whether the report uses current dimensions or historical dimensions at event time, then design refresh/denormalization accordingly.

Properties such as `excluded_trigger_tables` and `grace_period` are correctness trade-offs, not free speed. Excluding a changing dimension from refresh triggers or allowing stale rewrites can serve obsolete results. Use only with an explicit freshness contract and independent reconciliation.

Test added/dropped base partitions, late arrivals, corrected old facts, dimension updates, deletes, and schema changes. The 4.1.4.1 release fixes an MTMV issue where adding a base partition triggered full refresh; patch release matters to cost as well as correctness.

## Transparent rewrite is conditional

Prove rewrite on the **actual application SQL** with `EXPLAIN`, profile evidence, and equivalent results. Merely creating a view or directly querying it does not establish transparent rewrite.

The checked overview lists constraints including window-function rewriting and MV definitions containing UNION ALL/LIMIT/ORDER BY/CROSS JOIN. Some definitions can be created but are not eligible for transparent rewrite. A view joining more tables than the query does is also restricted in the documented cases. Consult the exact current rewrite matrix rather than generalizing from SPJG terminology.

Account for:

- Equivalent predicates, casts, NULL behavior, join type, grouping granularity, and aggregate algebra.
- MV freshness/partition coverage and allowed stale-data settings.
- Optimizer statistics and cost: a usable MV need not be selected.
- Base-plus-MV partition compensation where supported.
- Query-plan overhead from too many candidate MVs.

A direct SELECT from an async MV may return stored stale data even when a transparent rewrite would avoid an invalidated partition. Do not interchange those two access paths without checking freshness behavior.

## CRM aggregation gotchas

Keep `tenant_id` and the correct business grain in stored results. Revenue joined to multiple contacts/labels can multiply before SUM. Average-of-averages is wrong unless appropriately weighted; store sum/count when rollup requires it. Distinct counts require a compatible exact or approximate representation; HLL is approximate and bitmap mapping must preserve identity. Ratios and currency conversion need explicit semantics.

Recompute or correctly retract contributions when mutable deals change stage, amount, owner, or deletion state. Aggregate-Key SUM does not automatically subtract an old value when a source entity is updated. Backfill/replay idempotency must match the aggregate design.

For external catalogs, source metadata/cache refresh and MV refresh are separate. The checked docs warn that external changes can be missed when metadata does not change; manual forced refresh may be necessary. Hudi, Iceberg partition evolution, and other catalogs have distinct limitations. Do not promise consistent cross-engine freshness from a successful Doris refresh alone.

## Validation and recovery

Compare base SQL and MV-backed SQL at a stable source watermark with row counts and value checks, not only latency. Measure refresh cost under production-like mutation rates, p95/p99 query latency, storage, and ingestion impact. Failure tests must cover interrupted refresh, missing partitions, schema evolution, and catch-up after an outage.

Keep MV definitions under version control. The checked BACKUP/RESTORE docs exclude async MVs; rebuild them and their refresh schedules after restore, then validate results and freshness. Treat MV rebuild time as part of RTO.

## Official sources

- [Sync MV](https://doris.apache.org/docs/4.x/query-acceleration/materialized-view/sync-materialized-view/)
- [Async MV overview](https://doris.apache.org/docs/4.x/query-acceleration/materialized-view/async-materialized-view/overview/)
- [Async MV use guide](https://doris.apache.org/docs/4.x/query-acceleration/materialized-view/async-materialized-view/use-guide/)
- [Partial-update incompatibilities](https://doris.apache.org/docs/4.x/data-operate/update/partial-column-update/)
- [Backup limitations](https://doris.apache.org/docs/4.x/admin-manual/data-admin/backup-restore/overview/)
- [4.1.4.1 MTMV fix](https://doris.apache.org/releases/v4.1/release-4.1.4.1/)
