# Architecture and version discipline

## Engine and deployment decisions

Treat Doris as a distributed analytical/search engine with MySQL-protocol access—not as a drop-in transactional MySQL server. FE handles metadata, planning, scheduling, and coordination; BE handles execution and storage/cache work. Columnar storage, vectorized execution, pruning, distributed joins, and compaction make physical layout and write patterns matter.

| Mode | Choose for | Budget and verify |
|---|---|---|
| Integrated storage/compute | Local-disk performance; simpler fixed-capacity deployments | Replica placement, disk headroom, data movement during scale-out, failure-domain awareness |
| Decoupled storage/compute | Shared object storage; independently scaled compute groups | Meta Service/FoundationDB dependencies where applicable, object-store availability and requests, local cache capacity, cold starts, networking and egress |
| Kubernetes/operator | Existing Kubernetes operations and need for declarative lifecycle | Operator/Doris compatibility, persistent storage, disruption budgets, resource limits, upgrade/restore drills |

Do not infer HA from three processes on one machine. For an integrated production cluster, plan FE quorum with voting/follower roles, replicated data across independent failure domains, and enough surviving capacity for maintenance. Observers help reads; they are not interchangeable with voting FE members. Confirm exact deployment requirements in the matching installation guide.

Keep transactional systems responsible for workflows requiring relational constraints, multi-entity invariants, and operational writes unless Doris's exact transaction support demonstrably fits. Doris supports transactions, but SQL statement combinations and visibility semantics differ by release; do not reconstruct OLTP behavior from a familiar client protocol. Unique Key upserts are not general foreign-key enforcement.

## Release baseline and gates

Checked 2026-10-02: GitHub reports `4.1.4.1` as its latest release. Check the Apache download/release pages before choosing an installation. A vendor distribution may backport or disable features.

| Feature | Documented gate or constraint |
|---|---|
| Unique Key partial updates | MoW; INSERT path supported since 2.0.2 |
| Flexible per-row partial updates | Since 3.1.0; JSON and skip-bitmap table support; important exclusions in ingestion guide |
| Async materialized views | Present in 2.1; refresh/rewrite support depends on source type and patch release |
| Query `profile_level` 1–3 meanings | Current semantics apply in 4.0+; do not reuse blindly on earlier versions |
| ANN vector indexes | HNSW introduced in 4.0; IVF/IVF_ON_DISK described in 4.1 release notes |
| ANN on Unique Key MoW | Since 4.1.4 according to current index docs; earlier model restrictions differ |
| Auto bucket minimum | Changes from 1 to 3 in 4.0.8 / 4.1.4; affects newly created partitions |
| `LEVENSHTEIN` and `DAMERAU_LEVENSHTEIN_DISTANCE` | Docs explicitly say **since 4.2.0**, despite residing under `4.x`; do not use as 4.1 features |
| 4.1.4.1 hotfix | Fixes include MTMV added-partition full refresh, VARIANT WAL reads, nullable-Boolean crash, aarch64 startup on 64-KiB pages |

Record the package/image tag and digest, FE and BE build identifiers, Flink/Spark connector artifact versions, Java/Flink versions, and operator version. No Doris installation was supplied with this skill; none of its illustrative SQL should be represented as validated against the user's deployment.

## Documentation hazards

Treat versioned docs as living documents. The checked `4.x` tree includes later feature notes, so a matching URL is necessary but insufficient. Prefer explicit feature version notes and release notes over broad marketing statements.

Known inconsistencies in the researched pages:

- Stream Load timeout defaults differ between its header and FE configuration tables. Inspect the effective settings; do not prescribe an unexplained numeric default.
- Group Commit narrative uses `group_commit_interval`, while tuning sections specify `group_commit_interval_ms`. Use the documented property for the target release and verify `SHOW CREATE TABLE`.
- The NGram BloomFilter page describes character grams but includes a word-gram illustration. Do not copy that illustration as an algorithm specification; validate behavior with representative strings.
- General upgrade prose says patch releases add no features, but specific patch release/docs gates describe new capabilities. Trust the specific release evidence, not that generalization.

When a capability matters, reproduce it with tiny input before committing to a large design. Separate “documented,” “observed on version X,” and “recommended for this workload.”

## Lakehouse and integration coverage

Use catalogs for external Hive, Iceberg, Paimon, Hudi, JDBC, and other documented sources when querying in place is preferable to ingestion. Verify each catalog's supported reads/writes, authentication, partition pruning, delete-file handling, type mapping, and refresh behavior independently.

For repeated low-latency dashboards, compare external scans against an internal hot-data copy or an async MV. Include metadata/cache staleness, file sizes, object-store request costs, external statistics, and cold-cache latency. A successful catalog query does not imply transactionally fresh cross-system data. Do not embed source credentials in generated SQL, query logs, or committed examples.

Use native ARRAY/MAP/STRUCT/JSON/VARIANT types for appropriate data, but promote frequently filtered/joined fields to typed columns where measured benefits justify it. Use DECIMAL for money and a documented UTC/timezone conversion policy. Check connector conversion semantics, nullability, precision, and unsupported types.

For export, distinguish query result export from a restorable backup. Validate type round-trips, escaping, file manifests, row counts, permissions, and reload behavior. Schedule jobs with bounded retries and explicit failure ownership rather than assuming SQL execution implies successful downstream delivery.

## Official sources

- [Deployment choices](https://doris.apache.org/docs/4.x/install/choosing-deployment-mode/)
- [Cluster planning](https://doris.apache.org/docs/4.x/install/preparation/cluster-planning/)
- [Transactions](https://doris.apache.org/docs/4.x/data-operate/transaction/)
- [Catalog overview](https://doris.apache.org/docs/4.x/lakehouse/catalog-overview/)
- [Lakehouse optimization](https://doris.apache.org/docs/4.x/lakehouse/best-practices/optimization/)
- [4.1.0 release](https://doris.apache.org/releases/v4.1/release-4.1.0/)
- [4.1.4.1 release](https://doris.apache.org/releases/v4.1/release-4.1.4.1/)
- [Latest GitHub release](https://github.com/apache/doris/releases/latest)
