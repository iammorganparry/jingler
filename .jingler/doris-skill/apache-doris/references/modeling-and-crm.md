# Data modeling and CRM correctness

## Contents

- Choose the table model
- Illustrative current-state DDL
- Ordering and concurrent changes
- Partial updates and missing values
- Wide and evolving schemas
- Deletes, merges, and privacy

## Choose the table model

| Model | Semantics | Appropriate use | Trap |
|---|---|---|---|
| Duplicate Key | Preserve rows; key describes sorting, not uniqueness | Append-only events, logs, detailed facts | Replayed events are counted again unless deduplicated upstream |
| Unique Key, merge-on-write | Upsert by complete key; merge work on write | Contacts, companies, deals, associations, current state | Wrong keys, stale versions, and incomplete full-row writes silently change results |
| Aggregate Key | Combine values by configured aggregate functions | Stable pre-aggregated metrics with a defined algebra | Replaying SUM increments double-counts; REPLACE_IF_NOT_NULL cannot express clearing a value to NULL |

Declare MoW explicitly for new mutable-state tables. Existing MoR tables do not convert merely because the cluster was upgraded; the docs require a new-table/migration approach rather than changing implementation through schema change.

Model these separately:

- **Current entity state:** immutable tenant/source/entity identity, typed hot attributes, source version, ingestion timestamp, optional long-tail payload.
- **Event history:** stable event identity, tenant/entity identity, source event time, ingestion time, event kind, payload; retain/replay under an explicit policy.
- **Associations:** tenant, source object type/id, target type/id, association type/label namespace, version and deletion state. Support several labels between the same pair; do not lose association identity through oversimplified deduplication.
- **Property definitions:** tenant + object type + property identifier, declared source type, enumeration values, and schema revision. Identical property names can have different meaning between tenants.
- **Analytical facts:** deal stage transitions, email/call activity, and dated revenue facts. Preserve history needed for “as of” reports rather than repeatedly overwriting it.

Every join must match tenant and source namespaces, not just object IDs. Many-to-many association joins can multiply measures; aggregate or deduplicate at the intended business grain before counting revenue or contacts.

## Illustrative current-state DDL

This is a design example, not a universal production sizing recommendation. Confirm the release, source version contract, replica availability, ID representation, and bucket count first. Use strings if source identifiers cannot safely be represented by BIGINT.

```sql
CREATE TABLE crm_contacts_current (
    tenant_id BIGINT NOT NULL,
    contact_id BIGINT NOT NULL,
    source_version BIGINT NOT NULL,
    source_updated_at DATETIME(6) NULL,
    ingested_at DATETIME(6) NOT NULL,
    email_normalized VARCHAR(320) NULL,
    lifecycle_stage VARCHAR(64) NULL,
    properties VARIANT NULL
)
UNIQUE KEY(tenant_id, contact_id)
DISTRIBUTED BY HASH(tenant_id, contact_id) BUCKETS 16
PROPERTIES (
    "replication_num" = "3",
    "enable_unique_key_merge_on_write" = "true",
    "function_column.sequence_col" = "source_version"
);
```

Here `source_version` is an ingestion contract to implement, **not an assumption that a CRM source supplies a monotonic integer revision**. This table deliberately has no mutable time partition and expects coherent full after-images. Its VARIANT column means flexible partial updates are not an available option under the checked docs.

Do not make email the entity key: it can change, be absent, or be shared. Key columns lead the schema in declared order. Bucket columns must be key columns for Unique/Aggregate tables.

## Ordering and concurrent changes

A Sequence column lets a larger source version replace a smaller one for the **same complete key**. It does not establish an order between incomparable streams or fix a changed key. Conflicting equal-version payloads need upstream deterministic resolution; do not depend on an undocumented tie winner.

Example failure: field A changes at version 11, field B at version 12; B's partial patch arrives first. A row-level sequence can then reject version 11 entirely, losing A's legitimate update. Choose one of:

- Order patches per entity before materializing them.
- Reconstruct coherent complete after-images upstream, preserving source ordering.
- Keep independently versioned source-owned tables and join them.

Do not claim partial updates alone solve out-of-order patch reconstruction. Do not assign a larger version merely because a stale payload arrived later. Kafka offsets order records only within one partition and need a defined partition/epoch contract if used as versions.

The separate `sequence_mapping.<column>` feature is **MoR-only** in the checked guide, requires light schema change, cannot coexist with a global Sequence column, and excludes batch deletes. It is not an add-on to the MoW + CDC-delete design above.

For SQL UPDATE, the docs serialize updates on a table by default. Enabling `enable_concurrent_update` removes those guarantees; it is not a safe default throughput optimization.

## Partial updates and missing values

Read the ingestion guide before selecting fixed or flexible updates. Decide separately for:

| Input | Intended meaning |
|---|---|
| Omitted property | Unchanged, unknown, or omitted by an API projection—not automatically NULL |
| Explicit null/clear | Clear the stored value according to the source property semantics |
| Empty string | Source-specific value or clear marker; normalize deliberately |
| New entity with partial data | Reject/quarantine pending hydration, or append with an explicit default policy |
| Unknown/misspelled property | Reject or quarantine schema mismatch; do not silently discard |

A top-level VARIANT column is one update value; replacing it is not a guaranteed recursive JSON merge. Assemble the document or separate independently updated attributes before loading. A schema template conversion can turn incompatible values into NULL, so validate property types before assuming strict loading catches every semantic error.

## Wide and evolving schemas

Prefer typed columns for tenant/id, timestamps, money, common filters, and joins. Store long-tail custom properties as VARIANT or in a measured alternative. Read the current VARIANT workload guide for subcolumnization, sparse/DOC modes, schema templates, and high-cardinality paths.

Do not create a column for every tenant-specific property, encode arbitrary object IDs as JSON property names, or index every long-tail field. Those patterns cause metadata, index, compaction, and schema-evolution cost. Observe subcolumn growth and storage/read amplification. DOC/sparse behavior and templates are version-specific; do not paste dev settings into an older cluster.

For schema changes, classify lightweight versus rewriting operations, compatibility with active loads/partial updates, completion state, and rollback. Use dual writes/backfill plus reconciliation for identity or distribution changes rather than hoping ALTER changes existing layout. Preserve an old-reader/new-reader compatibility interval when producers and consumers deploy independently.

## Deletes, merges, and privacy

Carry the complete key and an ordered version on deletes. Doris uses `__DORIS_DELETE_SIGN__` for batch-delete paths; query invisibility precedes asynchronous physical compaction. Confirm whether the selected loader uses MERGE headers or flexible JSON delete markers.

Do not assume that delete-version protection survives forever after physical cleanup. Retain upstream deletion/version state through the maximum replay and restore horizon, or evaluate a retained soft-delete row with mandatory filtering. Minimize data in that ledger; privacy erasure and indefinite PII retention are incompatible.

For source object merges, maintain a canonical-ID/alias mapping, update associations, and remove/redirect losing IDs. Treat restore/recreation as a separate ordered event. Reconcile derived tables, MVs, search copies, raw archives, and backups under the erasure policy. A logical DELETE is not proof of physical erasure from every copy.

## Official sources

- [Unique Key model](https://doris.apache.org/docs/4.x/table-design/data-model/unique/)
- [Aggregate Key model](https://doris.apache.org/docs/4.x/table-design/data-model/aggregate/)
- [Concurrent updates and Sequence](https://doris.apache.org/docs/4.x/data-operate/update/unique-update-concurrent-control/)
- [Multi-stream Sequence Mapping](https://doris.apache.org/docs/4.x/data-operate/update/multi-stream-update-for-unique-model/)
- [Partial column updates](https://doris.apache.org/docs/4.x/data-operate/update/partial-column-update/)
- [Batch deletes](https://doris.apache.org/docs/4.x/data-operate/delete/batch-delete-manual/)
- [VARIANT](https://doris.apache.org/docs/4.x/sql-manual/basic-element/sql-data-types/semi-structured/VARIANT/)
- [VARIANT workload guide](https://doris.apache.org/docs/4.x/sql-manual/basic-element/sql-data-types/semi-structured/variant-workload-guide/)
- [Schema change](https://doris.apache.org/docs/4.x/table-design/schema-change/)
