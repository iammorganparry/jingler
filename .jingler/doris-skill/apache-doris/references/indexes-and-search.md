# Indexes, fuzzy search, and hybrid retrieval

## Contents

- Choose semantics before an index
- Built-in and selective indexes
- Full-text search
- NGram BloomFilter
- Typo tolerance and similarity
- Vector/hybrid search
- Verification and operational cost

## Choose semantics before an index

Ask what a match means if it is not already specified. “Fuzzy” can mean several incompatible things.

| Requirement | Candidate | What it does not imply |
|---|---|---|
| Exact normalized email/id/status | Equality predicate; suitable sort order or non-tokenized inverted index | Token matching or typo tolerance |
| Range/status/array-element filtering | ZoneMap, inverted index where supported | Benefit when nearly every row matches |
| Whole words in notes | Tokenized inverted index + MATCH family | Arbitrary substring matching |
| Ordered words | `MATCH_PHRASE` with phrase support | Edit-distance matching |
| Substring anywhere in text | `LIKE '%literal%'` + NGRAM_BF where eligible | Ngram similarity score or Levenshtein index |
| Similar ASCII spellings | `NGRAM_SEARCH` over a bounded candidate set | Index-backed lookup or exact identity |
| Character-edit typo tolerance | Supported edit-distance function or application reranking | Availability in all 4.x releases |
| Semantic meaning | ANN vector search, perhaps hybrid with lexical retrieval | Exact keyword/identifier match or guaranteed recall |

## Built-in and selective indexes

**Prefix index:** automatically built over the leading sort-key bytes; current docs describe a 36-byte limit and truncation on VARCHAR. Leftmost sort predicates matter. On Unique tables, do not add mutable fields to the identity merely to improve this index. Consider a secondary index or measured serving projection instead.

**ZoneMap:** automatically records min/max/null information at segment/page granularity. Correlated data order and direct selective predicates improve skipping. Broad, uncorrelated values reduce its value.

**Inverted index:** maps values/terms to row locations and supports documented equality/range/text/array operations. Select parser/analyzer based on semantics. No parser/tokenization is appropriate for exact values; language analysis is appropriate for natural text. Check table-model, type, operator, and storage-format support on the actual release.

**BloomFilter:** useful for selective equality/IN where its smaller footprint justifies it. It is probabilistic skipping, not a correctness substitute; positive hits still need predicate evaluation. Do not add it reflexively to low-cardinality or unselective columns.

Do not confuse BITMAP aggregate values used for distinct counting with a bitmap secondary index. Current index overview says the old BITMAP index has been replaced by inverted indexing. Check older release support when migrating.

## Full-text search

Use `MATCH_ANY` for any token, `MATCH_ALL` for all tokens, and `MATCH_PHRASE` for ordered phrase matching with the required phrase-index configuration. Tokenization, stemming, case normalization, punctuation, stop words, and multilingual text change results. Index the representation users actually expect to search.

For CRM data, exact email/phone/domain filters, person/company names, and free-text notes need different normalization. Preserve the original value and a versioned normalized representation. Do not tokenize an email and then assume token equality means an exact address match.

Illustrative index fragment for natural-language notes:

```sql
INDEX idx_notes(notes) USING INVERTED
PROPERTIES ("parser" = "english", "support_phrase" = "true")
```

The current 4.1 release documents `SEARCH()` expressions and BM25-style scoring, including Boolean, phrase, prefix, wildcard, regex, and nested paths. Read the operator guide before generating its DSL. Lucene-like syntax is not a promise of every Elasticsearch feature: do not assume `term~2` edit-distance fuzziness or analyzer behavior without explicit support. Regex operators differ in scope; for example, the checked SEARCH guide restricts its regex form to non-tokenized inverted indexes. `MATCH_REGEXP` over analyzed terms is not the same as SQL REGEXP over original text.

Escape user search input according to the actual SQL/DSL syntax. Parameterize SQL and bound search complexity, result size, and runtime. Never let a user-supplied expression remove mandatory tenant authorization predicates.

For indexes added to existing tables, verify historical build completion. The documented inverted-index workflow is CREATE INDEX followed by `BUILD INDEX` for existing data; do not equate successful DDL with full historical coverage. Inspect build status and error state using the release's SHOW commands.

## NGram BloomFilter: substring acceleration

`NGRAM_BF` is a **skip index** for eligible string `LIKE` predicates. It can rule out blocks; it does not directly return matching rows. False positives still require evaluating the original predicate, so correctness comes from LIKE, not the filter.

Illustrative fragment, not a production tuning result:

```sql
INDEX idx_company_name(company_name_normalized) USING NGRAM_BF
PROPERTIES ("gram_size" = "3", "bf_size" = "1024")
```

Then test the documented function-pushdown setting and a representative predicate:

```sql
SET enable_function_pushdown = true;
SELECT company_id
FROM companies
WHERE tenant_id = 42
  AND company_name_normalized LIKE '%acme%';
```

Important limits:

- A consecutive literal segment in the pattern must be at least `gram_size`. `'%ab%'` cannot benefit from 3-grams; `'%a%b%c%'` does not contain the same usable literal as `'%abc%'`.
- `gram_size` trades short-pattern support against selectivity/index work. `bf_size` controls BloomFilter size; the checked docs describe it in bits. Start from documented examples, then measure rather than blindly maximizing it.
- Regular BloomFilter and NGram BloomFilter are mutually exclusive on the same column in the checked docs.
- Do not expect arbitrary `LOWER(column)` or casts to use an index on the original value. Normalize at ingestion where that matches product semantics, or prove pushdown on the exact release.
- `NGRAM_SEARCH()` similarity scoring does **not** automatically use a NGRAM_BF index. Likewise, NGRAM_BF does not make arbitrary regex/edit-distance predicates indexed.

Inspect `RowsBloomFilterFiltered` and `BlockConditionsFilteredBloomFilterTime` along with scanned bytes/rows and wall time. An index can be used but unhelpful if most blocks contain common grams. Test short inputs, Unicode, punctuation, wildcard escaping, case, and broad patterns.

## Typo tolerance and similarity

The checked `NGRAM_SEARCH(text, pattern, gram_num)` documentation specifies ASCII only, constant pattern/gram count, a score in [0,1], and zero for strings shorter than the gram size. A score of 1 is **not proof of identical strings**. Do not use it for identity, dedupe correctness, or multilingual name matching without an alternative.

The docs for `LEVENSHTEIN` (aliases `LEVENSHTEIN_DISTANCE`, `EDIT_DISTANCE`) and `DAMERAU_LEVENSHTEIN_DISTANCE` explicitly say **since 4.2.0**. Their presence in `4.x` docs is not evidence they work on the observed 4.1.4.1 release. Damerau additionally handles adjacent transpositions; both describe UTF-8 character-based distance.

For older releases, use supported similarity functions only where semantics fit, or perform edit-distance reranking in the application. Do not invent an unsupported SQL function or install a UDF without security and operational review.

Candidate generation and reranking are separate:

1. Apply authorized tenant scope and safe filters.
2. Generate a bounded candidate set with appropriate lexical/normalized filters or a dedicated retrieval strategy.
3. Rank candidates with the intended similarity metric; apply a tested threshold.
4. Measure recall against labeled misspellings and disambiguation cases.

A restrictive exact prefix or substring candidate filter can exclude the typo you intended to recover. A simple pre-LIMIT can exclude the true nearest result. Treat candidate caps as an explicit approximation with measured recall, not an invisible optimization. Full-table edit-distance scans are generally not a scalable autocomplete design.

## Vector and hybrid search

Verify release/model support: current docs say ANN began in 4.0, IVF/IVF_ON_DISK appear in 4.1, and ANN on Unique Key MoW is supported since 4.1.4. Confirm `ARRAY<FLOAT> NOT NULL`, fixed dimensions, metric, normalization, supported query shape, and index build state.

Choose HNSW/IVF/disk-backed variants from measured recall, memory, build/refresh cost, update rate, and latency. Quantization reduces size at a recall cost; vendor benchmark ratios are not estimates for your data.

Use the documented approximate distance functions and matching ORDER BY/LIMIT shape; check the plan/profile for index use. For inner-product versus distance metrics, verify sort direction. Cosine via normalization requires consistent normalization of stored and query vectors.

For hybrid lexical/vector retrieval, combine candidate rankings with a documented or application-controlled fusion method. Do not add raw BM25 and vector distances as though they shared a scale. Apply tenant/ACL filters during retrieval where supported and enforce them before returning results; post-filtering alone can harm recall and does not excuse leakage.

Version the embedding model, dimension, normalization, and chunking. A new embedding model generally needs a migration/reindex strategy, not mixing incompatible vectors in one index. Test deletes, updates, stale embeddings, selective tenant filters, and cold-cache behavior.

## Verification and cost

Compare indexed/unindexed execution with identical semantics, data, cache conditions, and concurrency. Include ingest throughput, compaction, index build time, storage, and maintenance overhead—not just query p50. Do not build every possible index on every custom property.

Build a relevance corpus: exact IDs, typos, reversed letters, diacritics, multiple languages, short strings, stop words, symbols, phrases, same names in different tenants, and deleted records. Verify both result correctness and performance on the real patch release.

## Official sources

- [Index overview](https://doris.apache.org/docs/4.x/table-design/index/index-overview/)
- [Prefix index](https://doris.apache.org/docs/4.x/table-design/index/prefix-index/)
- [BloomFilter](https://doris.apache.org/docs/4.x/table-design/index/bloomfilter/)
- [Inverted indexes](https://doris.apache.org/docs/4.x/table-design/index/inverted-index/overview/)
- [SEARCH function](https://doris.apache.org/docs/4.x/table-design/index/inverted-index/search-function/)
- [Search operators](https://doris.apache.org/docs/4.x/table-design/index/inverted-index/search-operators/)
- [NGram BloomFilter](https://doris.apache.org/docs/4.x/table-design/index/ngram-bloomfilter-index/)
- [NGRAM_SEARCH](https://doris.apache.org/docs/4.x/sql-manual/sql-functions/scalar-functions/string-functions/ngram-search/)
- [LEVENSHTEIN: 4.2.0 gate](https://doris.apache.org/docs/4.x/sql-manual/sql-functions/scalar-functions/string-functions/levenshtein/)
- [Damerau-Levenshtein: 4.2.0 gate](https://doris.apache.org/docs/4.x/sql-manual/sql-functions/scalar-functions/string-functions/damerau_levenshtein_distance/)
- [Vector indexes](https://doris.apache.org/docs/4.x/table-design/index/vector-index/overview/)
