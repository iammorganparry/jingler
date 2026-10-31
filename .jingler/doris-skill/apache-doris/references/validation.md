# Validation and acceptance

## Scope the evidence honestly

This skill is a documentation-backed playbook, not a certified cluster configuration. No user Doris endpoint/version was supplied during authoring. Illustrative SQL and configuration must be tested on the exact target release before production use. Do not claim throughput, compatibility, or fault tolerance from reading documentation.

Use an isolated test database and synthetic non-PII data. Obtain approval before destructive operations, cluster reconfiguration, load generation, or failure injection. Record exact server/connector versions, DDL, configuration, data generator seed, expected results, and observed results.

## Correctness matrix

| Test | Input/action | Required observation |
|---|---|---|
| Tenant identity | Same entity ID in two tenants | Two independent rows; neither write/delete affects the other |
| Stable identity | Update mutable fields repeatedly | Exactly one current row per full logical entity key |
| Out-of-order after-images | Version 20, then version 10 for same key | Version 20 remains; no stale fields restored |
| Equal-version conflict | Different payloads with the same version | Contract rejects/resolves explicitly; do not accept an unexplained winner |
| Patch ordering | B at v12 before A at v11 | Final state retains both intended changes, or unsafe path is rejected |
| Missing vs NULL | Omit field, then explicitly clear it | Omission preserves; explicit clear follows agreed semantics |
| New-key patch | Patch unseen entity | Explicit ERROR/quarantine or approved APPEND/default behavior |
| Unknown field | Misspell a JSON column/property | Upstream validation catches it; no silent “successful” data loss |
| Partition mutation | Change a proposed partition/key attribute | Design rejects it or explicitly migrates old identity; no duplicate current row |
| Delete ordering | Delete newer version; replay older update | Remains deleted under the chosen ledger/order contract |
| Post-compaction replay | Repeat stale replay after physical cleanup | Deletion protection still holds or the documented limitation blocks deployment |
| Merge/recreation | Canonical-ID merge, later restore/recreate | Associations and current identity follow defined source semantics |
| Numeric/time correctness | Decimal extremes, UTC boundaries, DST, nulls | No silent precision loss, timezone drift, or cast-to-NULL corruption |
| Association fan-out | One fact linked to multiple contacts/labels | Counts/sums match business grain, not joined row multiplicity |

## Load and recovery matrix

| Test | Required observation |
|---|---|
| Same label/payload retried | One accepted logical batch; known finished/running/cancelled state |
| Response lost after server accepted data | Stable identity/status recovery; no new-label double application |
| Publish Timeout | Eventual visibility observed without duplicate reload |
| Retry after label retention | Business-level dedupe/reconciliation prevents double counting |
| Malformed row/type/unknown schema | Reject or explicit quarantine with loaded/filtered/unselected accounting |
| Routine Load starts/restarts | Chosen starting offsets, no accidental skip-to-end, recoverable pause |
| Flink checkpoint failure/restart/rescale | No lost business mutations; replay follows configured guarantee |
| Snapshot plus live changes | No gap, stale overwrite, or falsely inferred deletion at cutover |
| Async Group Commit BE failure | Measured acknowledgment/durability limits, replay from retained source |
| Old/future/null partition date | Reject/quarantine or deliberate routing; no runaway partitions |
| Expired event replay | Does not silently recreate data outside retention policy |
| Restore into isolated cluster | Reconciled base tables, deletes, source positions, MVs, policies, and measured RPO/RTO |

Do not simulate disk loss on a production BE or manually delete WAL files. Use approved disposable infrastructure and documented fault procedures.

## Search and MV matrix

| Area | Required cases |
|---|---|
| Exact match | Case/normalization, punctuation, NULL, same ID/name in two tenants |
| Full-text | Tokens, phrases/order, stop words, language analyzer, regex scope |
| NGRAM_BF | Literal length below/equal/above gram size, separated wildcards, escape characters, actual block skipping |
| Similarity | Labeled typos/transpositions, short strings, ASCII vs Unicode, candidate-filter false negatives |
| Version gate | 4.1 deployment never receives SQL requiring 4.2 edit-distance functions |
| ANN/hybrid | Recall@k, distance direction, normalized embeddings, selective tenant filters, stale/deleted vectors |
| Historical index build | Queries before/during/after build remain correct; final profile proves coverage/use |
| Sync MV | Supported model/query; initial build complete; actual base-query rewrite; write impact measured |
| Async MV | Direct-query staleness versus rewrite, refresh completion, invalid partitions, late facts and dimension updates |
| MV equivalence | Compare base and MV results at a stable watermark, including nulls, distincts, averages, and many-to-many joins |
| Tenant security | Unauthorized data absent from search, joins, views/MVs, exports, caches, and diagnostics |

## Performance acceptance

Run baseline and candidate against the same representative data and query mix. Include the largest tenant, sparse/wide properties, high association fan-out, updates/deletes, normal and burst ingestion, backfills, MV refresh, and cold/warm caches.

Report:

- Hardware, deployment mode, versions, dataset size/distribution, test duration and concurrency.
- Query p50/p95/p99 and throughput; queued vs execution time; scanned rows/bytes and profile bottleneck.
- Ingest throughput and **source-to-visible** lag, not just request acknowledgment latency.
- CPU, memory, disk/cache/spill/compaction load, storage/index/MV growth, rejected rows, and errors.
- Before/after correctness, failure recovery, rollback criteria, and remaining uncertainty.

Derive acceptance thresholds from the operator's SLOs. Do not invent a universal “HubSpot-scale” QPS or machine size. A performance improvement fails acceptance if it loses data, violates tenant isolation, or breaks the freshness/recovery budget.

## Skill-use evaluation prompts

Use these to check whether an agent actually applies the guidance rather than just recalling vocabulary:

1. “Time-partition current contacts by updated_at; keep 90 days.” Expected: identify identity/retention bugs; separate entity state and history.
2. “Enable flexible patches, VARIANT properties, sync aggregation, and Group Commit.” Expected: reject unsupported feature combinations and propose an explicit alternative.
3. “Make fuzzy name search fast on Doris 4.1 with NGRAM_BF.” Expected: distinguish LIKE from similarity/edit distance, respect 4.2 gates, measure candidate recall.
4. “A load timed out; retry with a fresh label.” Expected: resolve unknown outcome and preserve stable batch identity.
5. “Refresh only today's MV partition after changing a customer dimension.” Expected: account for historical join effects and full invalidation risk.

For each evaluation, require a concrete proposal, cited version constraints, at least one falsifiable check, and any unresolved question. Do not treat repeating a checklist as proof of database behavior.
