# Partitions, distribution, and retention

## Separate the three decisions

- **Partition:** data lifecycle and coarse pruning. Choose an immutable business dimension or time range when it enables retention, replacement, or query pruning.
- **Bucket/tablet:** distribution, parallelism, and recovery unit within a partition. Choose a hash key and count from data size, skew, and access paths.
- **Sort key/index:** order within stored data and efficient filtering. Do not conflate sorting with partitioning or invent mutable Unique Key columns to improve sort order.

A table without an explicit partition clause still has one implicit partition. Unique/Aggregate partition and hash-bucket columns must be key columns. Duplicate tables permit random distribution; Unique/Aggregate tables do not.

## Choose partition strategy by data semantics

| Data | Starting design | Reason |
|---|---|---|
| Current contacts/companies/deals | No time partition; stable composite Unique Key | A customer created years ago may still be active and updated today |
| Append-only activities/events | Day/month range on event date, sized from volume and retention | Pruning and efficient lifecycle deletion |
| Rebuildable daily facts | Time partitions aligned with recomputation | Replace only affected ranges |
| Small bounded tenant set with strong lifecycle needs | Evaluate explicit tenant/list partitions | Tenant-level lifecycle benefits, but metadata cost grows with tenant count |
| Unbounded tenants or high-cardinality properties | Avoid one partition per distinct value by default | Automatic partition creation can explode metadata/tablet count |

Do not time-partition entity state by `updated_at`. In `UNIQUE KEY(tenant_id, updated_date, entity_id)`, changing the date creates another complete key; it does not move/delete the old row. Even `created_at` is unsafe if source corrections can change it. A migration must explicitly remove the old identity.

## Manual, dynamic, and auto partitioning

**Manual RANGE/LIST:** use deterministic ranges and explicit lifecycle jobs. Fixed range intervals are left-closed/right-open. Validate month boundaries, leap days, timezone conversions, and values outside defined ranges.

**Dynamic partitions:** scheduled creation/deletion of time ranges using `dynamic_partition.*`. Verify scheduler enablement and job status on the cluster, not only table properties. A negative `start` does not itself create old partitions: `create_history_partition` and historical-range controls also matter. Set timezone explicitly and define the accepted late-event window. A boundary can change while a backfill is running.

**Auto partitions:** create partitions as values arrive; useful when valid incoming dates are not predictable. Check supported types/expressions, null restrictions, maximum partition count, and failed-load leftovers. AUTO LIST can create a partition for each unseen tuple. Invalid/far-future dates must be rejected upstream, not allowed to create arbitrary partitions.

**Retention:** auto `partition.retention_count` counts historical partitions by greatest partition values; it is not a duration in days when dates are sparse. Current/future partitions are treated separately. The checked 4.1.4 docs reject enabling this alongside dynamic partitioning. Verify exact version behavior and choose one lifecycle owner.

Auto creation is not retention enforcement. An old late record can recreate a dropped range if the path allows it. Reject/quarantine out-of-policy event dates upstream and test this after expiration. Keep raw replay data only within approved privacy/retention policies.

## Bucket key selection

For highly skewed SaaS tenants, `HASH(tenant_id)` maps one tenant to a single bucket in each partition. Prefer evaluating `HASH(tenant_id, entity_id)` for current state: it spreads a large tenant's entities but tenant-only queries then touch more buckets. This is an explicit skew-versus-pruning trade-off.

Evaluate:

- Full-key point lookup versus tenant-wide scans and cross-tenant analytics.
- Write hotspots, including one exceptionally active entity that hashing cannot split without changing identity.
- Cardinality/skew of the complete hash tuple, not each column in isolation.
- Join locality: compatible distribution can reduce shuffles; colocated tables require matching group constraints and operational stability, not merely similar DDL.

Never fix skew by dropping tenant from identity or authorization checks.

## Size tablets using measured compressed data

The checked docs recommend **1–20 GB compressed data per tablet, excluding indexes**, with **no more than 10 GB for Unique Key** as a starting heuristic. These are recommendations, not hard service limits or a universal performance optimum. The same docs provide coarse count tables that can conflict with size guidance; prioritize measured size, recovery, and target workload.

Estimate per partition:

```text
base_tablets ≈ sum(bucket_count_for_each_partition)
replica_tablets ≈ base_tablets × replication_factor          # integrated mode
with_rollups ≈ sum(partition buckets across base + indexes) × replicas
initial_buckets ≈ ceil(compressed_partition_bytes / target_tablet_bytes)
```

Count async MVs as their own physical tables; not every secondary index is another tablet. Include index bytes, row-store duplication, retained versions, compaction scratch space, replicas, and temporary backfills when budgeting disk.

Example, not a sizing prescription: 365 daily partitions × 32 buckets × 3 replicas = **35,040 replica tablets** before rollups or extra tables. A thousand tenant tables multiply the small-table problem even when total bytes are modest.

`BUCKETS AUTO` estimates counts for new partitions; it does not continuously rebalance existing ones. `estimate_partition_size` informs the initial estimate. The lower-bound default changed from 1 to 3 in 4.0.8 / 4.1.4, so sparse new partitions may create more tablets after an upgrade. Dispersed updates/backfills do not necessarily match chronological auto-sizing assumptions.

The checked docs do not support changing the existing bucket key, distribution type, or already-created partition bucket count in place. Plan a rebuild/cutover if those assumptions change. Increasing BE count alone does not rewrite hash distribution into more buckets.

## Prove pruning and lifecycle behavior

Use `SHOW CREATE TABLE`, `SHOW PARTITIONS FROM table_name`, `SHOW TABLETS FROM table_name`, and `EXPLAIN` for representative queries. Check actual partitions/tablets scanned in the plan/profile, not just the presence of a partition column in SQL. Prefer direct half-open predicates; functions/casts around partition keys can prevent useful pruning.

Before deleting/replacing a partition, enumerate its boundaries, row counts, source coverage, and downstream views; obtain approval. For corrections, consider staging a replacement and the documented atomic partition/table replacement mechanism. Prove reader visibility and rollback on the exact release; do not drop the old data first.

## Official sources

- [Manual partitioning](https://doris.apache.org/docs/4.x/table-design/data-partitioning/manual-partitioning/)
- [Dynamic partitioning](https://doris.apache.org/docs/4.x/table-design/data-partitioning/dynamic-partitioning/)
- [Auto partitioning and retention](https://doris.apache.org/docs/4.x/table-design/data-partitioning/auto-partitioning/)
- [Bucketing](https://doris.apache.org/docs/4.x/table-design/data-partitioning/data-bucketing/)
- [Colocation join](https://doris.apache.org/docs/4.x/query-acceleration/colocation-join/)
