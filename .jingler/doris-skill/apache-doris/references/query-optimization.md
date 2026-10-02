# Query optimization: diagnose before tuning

## Capture a reproducible baseline

Record exact SQL/parameters, Doris version, schema/index definitions, row counts and tenant skew, source watermark, concurrency, cache warmth, and simultaneous ingestion/refresh work. Measure client end-to-end latency and server execution separately; queueing, planning, network transfer, and rendering can dominate a fast scan.

Collect p50/p95/p99, throughput, scanned bytes/rows, peak memory, spilled bytes, CPU, IO, and source freshness. Compare identical semantics and representative result sizes. An empty-result benchmark or one tiny tenant is not production evidence.

```sql
SET enable_profile = true;
EXPLAIN SELECT tenant_id, COUNT(*)
FROM contacts_current
WHERE tenant_id = 42
GROUP BY tenant_id;

SELECT tenant_id, COUNT(*)
FROM contacts_current
WHERE tenant_id = 42
GROUP BY tenant_id;
SHOW QUERY PROFILE;
```

Use the FE profile UI or documented profile retrieval endpoint for operator detail; a query ID alone is not analysis. Profile persistence/collection can lag. Current `profile_level` semantics are 4.0+; higher detail has overhead. Prefer targeted sessions/slow-query collection over unlimited global profiling.

## Diagnose in this order

| Evidence | Likely area | Smallest useful experiment |
|---|---|---|
| Long queue before execution | Concurrency admission/resource saturation | Lower admission, separate workloads, measure waiting time |
| Excessive planning time | Many tables/MVs, complex SQL, metadata access | Simplify generated SQL or candidate MVs; inspect planning stages |
| Too many partitions/tablets scanned | Unprunable predicates or layout | Direct range predicates, correct types, measured partition layout |
| High scan bytes, few result rows | Missing selective access path | Sort/index choice, column projection, predicate pushdown |
| Estimated vs actual cardinality mismatch | Statistics or skew | Refresh relevant statistics and inspect tenant distributions |
| Expensive exchange/shuffle | Join distribution or aggregation placement | Compatible hash keys, broadcast only a truly small side, preaggregate safely |
| One slow fragment/BE | Skew/hot tablet/IO imbalance | Compare per-instance maxima, distribution and tablet size |
| High memory/spill | Join build side, distinct/group cardinality, sort | Reduce early data, correct plan, bounded workload resources |
| Fast server but slow client | Large results/network/client | Projection, paging, result-size limits |
| Degradation during writes | Compaction/version pressure or contention | Batch/throttle ingestion; isolate backfills/refreshes |

Do not sum overlapping parallel operator times as if they were wall-clock time. Compare critical-path and per-instance maximums against averages; a single straggler can govern latency.

## Statistics and optimizer

Doris's cost-based optimizer needs useful cardinality/size statistics. Current docs describe automatic collection, but it is not a guarantee every table is fresh on a fixed schedule. Wide-table thresholds and unsupported complex column types matter for CRM VARIANT-heavy schemas.

```sql
ANALYZE TABLE contacts_current;
-- For a large table, evaluate an explicit sample rather than forcing a full scan.
ANALYZE TABLE contacts_current WITH SAMPLE ROWS 100000;
```

Choose one appropriate collection strategy, inspect completion, and recheck the plan. The sample count above is illustrative. Capture before/after estimates and actuals; sampling can miss rare values or extreme tenants. Promote frequently joined/filtered long-tail attributes to typed columns only when measurement warrants it.

Avoid blanket join-order/shuffle hints before correcting statistics, types, predicates, and skew. If a hint is necessary, scope it to the query, document the observed plan defect, and regression-test across releases/data growth.

## Joins and analytical correctness

Join on tenant + source namespace + business ID. Normalize compatible key types to avoid casts and mismatches. Filter/project early when semantics permit it; changing an outer join filter's placement can change results.

Compare broadcast, shuffle/bucket shuffle, and colocated joins from actual plan/profile evidence. A dimension that is small globally today can outgrow broadcast memory. Compatible hashing alone does not prove a colocated join; group definitions, bucket/replica constraints, and placement stability matter.

Deduplicate association edges or aggregate at the fact grain before many-to-many joins. Use existence/semijoin patterns when the question is membership rather than multiplicity. Validate against a known-answer dataset before celebrating faster wrong counts.

Use materialized views only after accounting for their refresh/invalidation cost. For mutable dimensions, denormalizing every property into event history can trade cheap queries for expensive fan-out rewrites; compare current-versus-as-of semantics explicitly.

## Scans, indexes, and results

Keep predicates sargable/direct where possible. Prefer half-open timestamp ranges to formatting the stored timestamp into a string. Align parameter types to columns and test timezone boundaries. Project only necessary columns, especially with wide VARIANT/JSON payloads.

For TopN and selective lookups, verify the optimizer's supported pushdown/lazy materialization or row-store path rather than setting global knobs from unrelated benchmarks. Deep OFFSET pagination performs growing work; evaluate stable keyset pagination where product ordering permits it. Add a deterministic tie-breaker and define how concurrent updates affect paging.

Do not force every filter through an index: scanning is reasonable when most rows match. Search relevance, exactness, and NULL semantics must remain unchanged between alternatives.

## Memory, spill, and workload controls

Use supported spill paths as a safety valve, not as extra free RAM. Provision fast spill storage, headroom, and isolation from compaction/cache IO. Confirm which operators spill on the release and track spill latency/bytes.

Workload groups can limit or queue queries and isolate workloads; property names and semantics have changed across releases. Inspect supported/effective settings before writing configuration. Tune maximum concurrency, queue length, timeout, CPU/memory bounds, and IO against an SLO. Unlimited concurrent dashboard queries can destroy both ingestion freshness and interactive latency.

For decoupled deployments, measure object-store fetches and cache hit/miss behavior, especially after scaling/restart. Warm-cache microbenchmarks do not predict first-query latency or recovery performance.

## Benchmark design

Include small/median/largest tenants, realistic selectivity, property cardinality, association fan-out, wide sparse documents, late updates, deletes, and burst ingestion. Run dashboards alongside backfills and MV refreshes. Compare cold/warm runs and repeat enough to expose variance; report dataset and hardware, not an unqualified QPS claim.

Change one factor, keep raw measurements, and retain a correctness check. Roll back changes that improve p50 but violate p99, freshness, cost, or recovery targets.

## Official sources

- [Query Profile](https://doris.apache.org/docs/4.x/query-acceleration/query-profile/)
- [Statistics](https://doris.apache.org/docs/4.x/query-acceleration/optimization-technology-principle/statistics/)
- [Colocation join](https://doris.apache.org/docs/4.x/query-acceleration/colocation-join/)
- [Workload groups](https://doris.apache.org/docs/4.x/admin-manual/workload-management/workload-group/)
- [Spill](https://doris.apache.org/docs/4.x/admin-manual/workload-management/spill-disk/)
- [Lakehouse optimization](https://doris.apache.org/docs/4.x/lakehouse/best-practices/optimization/)
