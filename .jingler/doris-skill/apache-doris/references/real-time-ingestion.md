# Real-time ingestion, CDC, and recovery

## Contents

- Choose a load mechanism
- Define an end-to-end contract
- Stream Load outcomes and retries
- Partial updates and feature combinations
- Kafka and Flink
- Group Commit
- Backfills, quality, and throughput

## Choose a load mechanism

| Input/workload | Starting choice | Verify |
|---|---|---|
| Application-produced batches/files | Stream Load | Stable labels, response JSON, conversion/filtering, network redirects |
| Kafka topic already normalized for Doris | Routine Load | Starting offsets, partition routing, job state, error policy |
| Database CDC with transforms or stateful ordering | Flink CDC + Doris connector | Compatible connector/Flink/CDC versions, checkpoints, 2PC, deletes and schema evolution |
| Large historical object-store/filesystem data | Broker Load or documented INSERT/file-table-function path | File manifests, atomic scope, source access, type mapping, reconciliation |
| High-frequency small inserts | Batch first; evaluate Group Commit | Visibility, WAL durability, mode fallback, incompatibilities |

Avoid one request per changed CRM property. Bound batches by both bytes and time, with a maximum record count for resource safety. Measure end-to-end freshness, not only HTTP response time.

## Define an end-to-end contract

Use a durable raw/event log and an explicit transformation/materialization stage when replay, ordering, or multiple sinks are required:

```text
source snapshot + changes
  -> durable replay log (source position + identity + payload/schema version)
  -> dedupe / order / reconstruct after-images / normalize deletes
  -> bounded Doris loads
  -> verify committed visibility and reconcile
```

Specify source event identity, full entity key, source ordering/version, schema version, event time, ingest time, and operation. Distinguish business duplicates from a retried delivery. Advance source checkpoints only at the durability/visibility point required by the chosen connector contract. Persist dead-letter records with reasons; a failed batch is not permission to discard it.

Do not call this pipeline exactly-once merely because one component does. Source retries, duplicate business events at distinct offsets, transform restarts, changed labels, and expired deduplication windows remain separate failure modes.

## Stream Load outcomes and retries

Use a stable label for the same logical batch and immutable payload. Labels deduplicate only within Doris's retained history; the checked docs describe a three-day default controlled by `label_keep_max_second`. Inspect the actual setting and maximum retry/backfill horizon.

Interpret **HTTP status and response JSON**. Inspect `Status`, `Message`, `TxnId`, `Label`, total/loaded/filtered/unselected rows, and `ErrorURL` when present.

| Outcome | Action |
|---|---|
| Success | Record completion and row accounting; verify the required visibility contract |
| Publish Timeout | The documented transaction completed but publication is delayed; track/query status instead of issuing a new-label duplicate |
| Label Already Exists + FINISHED | Prior batch succeeded; do not load it again |
| Existing batch RUNNING | Observe its state; do not create a parallel new identity |
| CANCELLED | Diagnose, correct/retry under the documented label reuse rules |
| Network response lost | Treat outcome as unknown; resolve transaction/label state or retry with the same label |
| Label history expired | Reconcile using durable business/event identity; label dedupe is no longer proof |

The generic response table and retry FAQ differ on duplicate-label advice; use the retry FAQ's state-aware handling, not a blanket “new label” rule.

FE may redirect Stream Load to a BE. Validate reachability, DNS, HTTPS termination, auth forwarding, and approved redirect targets. Never blindly forward credentials to an arbitrary redirect. Keep passwords/tokens out of shell arguments, logs, examples, and source control. Exact HTTP client/proxy configuration must fit the deployment.

Start correctness-sensitive loads with explicit `strict_mode:true` and `max_filter_ratio:0`, then test null/default conversions. These flags do not validate every domain rule or nested schema coercion. `WHERE`-excluded rows are not necessarily counted as errors; inspect unselected rows too. Preserve error evidence without logging PII.

## Partial updates and feature combinations

Ordinary subset-column INSERT is a **full-row upsert** unless partial-update mode is enabled. Reset session settings when using pooled connections; one session's partial mode must not silently alter unrelated inserts.

| Mode | Configuration | Constraints |
|---|---|---|
| Full after-image | Default full-row semantics | Include every required field and source version; omitted values may become defaults/NULL |
| Fixed columns | Stream Load `partial_columns:true` + explicit `columns`; INSERT `enable_unique_key_partial_update=true` | Include all keys; same changed-column set across the batch; MoW; schema-change/sync-MV restrictions |
| Flexible columns | `unique_key_update_mode:UPDATE_FLEXIBLE_COLUMNS` | Since 3.1.0; JSON; MoW + `enable_unique_key_skip_bitmap_column=true`; per-row fields may differ |

Choose `partial_update_new_key_behavior` explicitly where supported: `ERROR` rejects an unknown key; `APPEND` inserts and fills omitted fields with defaults/NULL or fails if a required value is unavailable. Do not accidentally create half-populated entities from an early patch. Version-check this control rather than assuming all historical partial-update implementations expose it.

For flexible updates, the checked docs exclude:

- Tables containing VARIANT, or synchronous materialized views.
- `group_commit`, `columns`, `jsonpaths`, `where`, `fuzzy_parse`, and several other mapping options.
- `merge_type` / `delete` headers; use the documented JSON `__DORIS_DELETE_SIGN__` path instead.
- The load-time `function_column.sequence_col` mapping parameter. Evaluate table-mapped sequence support separately and prove behavior on the exact release.

Unknown JSON column names can be ignored. Validate them upstream to catch misspelled properties. All key columns are mandatory. Distinguish omitted fields from explicit NULL and test absent-key behavior. Flexible updating is not a recursive merge into a VARIANT document.

Partial MoW updates still read/fill historical row values; fewer bytes sent does not guarantee cheap writes. Benchmark NVMe/local cache and optional `store_row_column` against extra storage and write amplification before enabling it.

## Kafka and Flink

**Routine Load:** each task uses a transaction; docs describe exactly-once Kafka ingestion. This does not remove duplicate application events published at different offsets. Specify initial offsets explicitly—the documented default is `OFFSET_END`, not “load all history.” Route an entity consistently and use a valid version contract for out-of-order data.

Observe `SHOW ROUTINE LOAD`, state/pause reason, committed offsets, source lag, error samples, rejected/unselected counts, and task concurrency. Kafka partition count limits useful consumption parallelism. Do not reset offsets or recreate a job until reconciling what was committed.

Configure both error controls explicitly. Current docs list Routine Load defaults of `max_filter_ratio=1.0`, `max_error_number=0`, and `strict_mode=false`; they interact and differ from Stream Load. For strict CRM synchronization, test the zero-error policy and ensure pause alerts result in recovery rather than silent permanent staleness.

**Flink:** select the exact connector compatibility matrix before copying options. Review `sink.enable-2pc`, checkpointing, label-prefix uniqueness, retries, transaction timeout/retention, savepoint restore, and sink batch mode. Document whether the selected mode ties visibility to checkpoints; do not claim every connector mode has the same latency or guarantee. Map deletes and source primary keys correctly. Test checkpoint failure, restart, rescale, and snapshot/change overlap.

A source log position is not automatically a comparable Doris BIGINT. Define conversion, overflow, epoch handling, source failover, and partition changes. Preserve enough source metadata to reconcile afterward.

## Group Commit

Group Commit reduces transaction/metadata overhead for many small loads. Prefer normal labeled loads first when correctness requirements dominate.

| Mode | Acknowledgment | Consequence |
|---|---|---|
| `off_mode` | Normal load behavior | Baseline for labels and explicit load control |
| `sync_mode` | After grouped commit | Commit wait affects latency; check visibility |
| `async_mode` | After WAL write, before commit | Response latency is not data freshness; WAL is single-replica in the checked docs |

Single-replica WAL can be lost with the corresponding disk. Retain replay capability and do not present async acknowledgment as equivalent to replicated committed data. Use documented decommissioning, not abrupt removal of a BE with pending WAL.

Explicit labels, 2PC, and column-update writes cause documented fallback for ordinary Group Commit paths; flexible updates forbid `group_commit`. Check the actual response/mode. Commit order is not guaranteed, so use source sequencing for Unique tables. Tune `group_commit_interval_ms` and `group_commit_data_bytes` only after checking target-release properties and freshness limits.

## Backfills, quality, and throughput

Start capturing changes before the snapshot, record a consistent source boundary, load the snapshot, then replay/reconcile overlapping changes. If a consistent snapshot/position pair is unavailable, document that limitation and use overlapping windows plus reconciliation; do not invent snapshot isolation.

Backfill into staging/rebuild tables when safer. Prevent older snapshots from overwriting newer serving state with source-version checks. Compare counts, keys, null rates, version maxima, checksums at stable watermarks, deleted entities, and representative values per tenant/range. Verify snapshot deletions—not seeing a row in a partial extract is not evidence it was deleted.

Tune batch size and concurrency against FE transaction pressure, BE memory/flush, compaction backlog, tablet versions, disk IO, and source lag. More loader threads can worsen all of them. Isolate backfills from live ingestion and dashboards. Throttle when downstream maintenance cannot keep up; preserve replay data long enough for recovery.

## Official sources

- [Stream Load](https://doris.apache.org/docs/4.x/data-operate/import/import-way/stream-load-manual/)
- [Routine Load](https://doris.apache.org/docs/4.x/data-operate/import/import-way/routine-load-manual/)
- [Routine Load best practices](https://doris.apache.org/docs/4.x/data-operate/import/load-best-practices/routine-load-best-practices/)
- [Load best practices (official source; rendered page unavailable at research time)](https://github.com/apache/doris-website/blob/4024df5fd795c1828853dd38d22a829cb8b3b193/versioned_docs/version-4.x/data-operate/import/load-best-practices/load-best-practices.md)
- [Group Commit](https://doris.apache.org/docs/4.x/data-operate/import/load-best-practices/group-commit-manual/)
- [Flink Doris connector](https://doris.apache.org/docs/4.x/connection-integration/data-integration/flink-doris-connector/)
- [Partial updates](https://doris.apache.org/docs/4.x/data-operate/update/partial-column-update/)
- [Sequence](https://doris.apache.org/docs/4.x/data-operate/update/unique-update-concurrent-control/)
