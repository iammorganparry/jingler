# Production operations and failure recovery

## Capacity and availability

Size from representative compressed bytes, query concurrency, update rate, index/MV amplification, and recovery targets—not total source rows alone. Reserve space/IO for compaction, retained versions, index builds, schema changes, temporary backfills, and replica repair. Avoid a universal “safe disk utilization” number; derive headroom from worst-case maintenance and growth.

For integrated clusters, verify FE quorum, BE replica placement, failure domains, balanced tablets, and surviving capacity during a node outage. For decoupled clusters, include metadata services, shared storage, compute groups, local cache, and network dependencies in the availability model. Replicas, object-store durability, and high availability do not replace independent recoverable backups.

Start with read-only inventory:

```sql
SHOW FRONTENDS;
SHOW BACKENDS;
SHOW CREATE TABLE contacts_current;
SHOW PARTITIONS FROM contacts_current;
SHOW TABLETS FROM contacts_current;
SHOW ROUTINE LOAD;
```

Use the release's metrics/system tables and Prometheus/Grafana integrations to add trends. Restrict management endpoints to authorized networks/users; do not expose FE/BE admin APIs publicly for convenience.

## Monitor the pipeline, not just node health

| Area | Watch | Action trigger |
|---|---|---|
| Data freshness | Source watermark vs visible Doris watermark per tenant/source | Freshness SLO exceeded even if nodes are healthy |
| Loads | Committed/failed loads, filtered/unselected rows, unknown outcomes, Routine Load pause/lag | Data loss risk, persistent pause, lag growth |
| FE | Quorum/leader state, heap/GC, transaction and planning pressure | Metadata/transaction bottleneck or quorum risk |
| BE | CPU, RSS, query/ingest memory, IO latency, free space, tablet distribution | Saturation, imbalance, OOM, inability to repair |
| Compaction | Backlog/score, rowsets/versions, failure counts, throughput | Maintenance falling behind write rate |
| Queries | Queue time, p95/p99, cancellation, spill, per-group use | Latency/resource isolation breach |
| MVs/indexes | Build/refresh status, freshness, duration, invalid partitions | Stale serving results or failed historical build |
| Recovery | Last successful backup and last successful restore drill | RPO/RTO not demonstrably achievable |

Choose exact metric names from the installed release; do not invent names. Alert on slopes and sustained lag, not only one instantaneous high counter. Redact query text, payloads, emails, and tokens from shared diagnostic artifacts.

## Compaction and ingestion health

Doris accumulates rowsets/segments from writes and merges them in the background. High-frequency tiny batches can cause transaction overhead, too many versions/segments, and slow reads even if raw disk capacity is ample.

Fix the cause in this order: batch appropriately; reduce uncontrolled concurrency; inspect hot tablets and partition spread; verify disk/CPU/memory headroom; then consider documented compaction settings. Raising version/segment limits without solving sustained backlog postpones failure.

Vertical compaction can reduce memory pressure for wide tables. Segment compaction targets too many segments during large loads, but adds CPU/memory work; do not enable it reflexively when loading already exhausts memory. Time-series compaction policies target time-local workloads, not every mutable CRM table. Verify supported model/mode and benchmark before changing policy.

Never delete BE data/WAL files manually to clear an alarm. Preserve failure evidence, use supported repair/decommission procedures, and verify replay/replica recovery. More compaction threads are not automatically more throughput on a saturated device.

## Tenant security and privacy

Tenant columns in keys, buckets, and joins prevent collisions; they do **not** authorize access. Apply least privilege, separate loader/admin/query roles, parameterized SQL, mandatory tenant predicates, and reviewed row/column policies where supported. A shared service account's row policy does not magically know the application user's tenant.

Test cross-tenant denial through every path: direct tables, views/MVs, joins, exports, search, cached results, and diagnostic endpoints. Include tenant identity and authorization context in application cache keys. Workload groups isolate resources, not data.

Use TLS for supported client/FE and ingestion paths; audit actual BE redirect/proxy handling separately. Keep secrets in an approved secret manager or protected client configuration, not inline SQL, CLI process arguments, logs, or stored skill examples. Restrict external catalog/UDF access: remote JDBC jars, UDFs, and credential-bearing catalog definitions are security-sensitive code/configuration.

Logical deletion, compaction, backup retention, raw logs, dead letters, external lake files, and caches have different physical retention timelines. Map privacy erasure across them. Prevent restore/replay from resurrecting erased entities with a minimal appropriate deletion ledger and a restore filtering policy. Do not promise a physical-erasure deadline from a successful DELETE response.

## Backup and restore

The checked native BACKUP/RESTORE docs explicitly limit support to **integrated storage/compute**. They exclude decoupled mode, async MVs, and tables with storage policies; only full backups are supported, with partition selection as an approximation to incremental operation. One backup/restore task runs per database at a time.

For a supported integrated deployment:

- Store backups outside the cluster/failure domain with restricted access and retention policy.
- Capture DDL, roles/policies, load jobs/source offsets, connector settings, MV definitions/schedules, and external dependencies separately as needed.
- Confirm completion and a usable snapshot manifest; “job submitted” is not a backup.
- Restore to an isolated target and reconcile at a known source watermark. Native restore does not preserve every operating attribute: recheck colocate settings and dynamic partition enablement; rebuild async MVs.
- Measure replay/catch-up plus MV rebuild time in RTO, and source/backup position gaps in RPO.

For decoupled deployments, use the documented mode-specific recovery/export/replication procedures for the target release and protect metadata as well as objects. Do not invent native BACKUP support or claim copying an object-store bucket produces a consistent recoverable cluster. If the recovery procedure has not been tested, report that as an unresolved production blocker.

Never validate a backup by restoring over the only live copy. Preserve the original until a clean restore and reconciliation pass.

## Upgrades, scaling, and schema changes

Read release notes across the exact upgrade path and verify metadata compatibility, connector/operator support, and storage-format changes. Do not prescribe one node-upgrade order for every topology/release; use the matching official procedure. Canary representative reads/writes/deletes, MVs, and search before broad rollout.

Take supported backups and exercise rollback on a separate environment. “Replace binaries with the old version” is not a universal rollback strategy after metadata changes. Record any temporary balancing/repair settings and ensure they are restored even if the upgrade fails.

Scale with supported node/compute-group operations. For integrated BE removal, wait for decommission/replica migration to complete and verify health; account for pending Group Commit WAL. Adding nodes redistributes work/data but does not redefine existing bucket counts. For decoupled compute changes, include cache warmup and object-store load in the plan.

Schema-change jobs may be asynchronous and incompatible with active partial-update paths. Observe completion, errors, memory/disk impact, and ingest catch-up. For destructive identity/type changes, prefer a new table plus backfill/replay, dual comparison, and controlled cutover rather than a blind ALTER.

## Incident response

Preserve timestamps, query/load IDs, source positions, FE/BE build IDs, error samples, and relevant metrics. Determine whether the problem is incorrect data, delayed visibility, a paused consumer, query regression, or availability failure before mutating anything.

Stabilize by bounded admission/throttling or pausing nonessential backfills/refreshes while preserving replay. Diagnose the limiting component, apply one reversible change, and verify both correctness and recovery of freshness. Never clear evidence by resetting offsets, dropping partitions, or recreating jobs as the first troubleshooting step.

## Official sources

- [Security overview](https://doris.apache.org/docs/4.x/admin-manual/auth/security-overview/)
- [Data access control](https://doris.apache.org/docs/4.x/admin-manual/auth/authorization/data/)
- [Backup and restore limitations](https://doris.apache.org/docs/4.x/admin-manual/data-admin/backup-restore/overview/)
- [Cluster upgrade](https://doris.apache.org/docs/4.x/admin-manual/cluster-management/upgrade/)
- [Compaction](https://doris.apache.org/docs/4.x/admin-manual/trouble-shooting/compaction/)
- [Workload groups](https://doris.apache.org/docs/4.x/admin-manual/workload-management/workload-group/)
- [Group Commit WAL](https://doris.apache.org/docs/4.x/data-operate/import/load-best-practices/group-commit-manual/)
