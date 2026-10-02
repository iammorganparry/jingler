import concurrent.futures
import json
import pathlib
import urllib.request

root = pathlib.Path(__file__).parent
paths = '''table-design/data-model/unique.md
table-design/data-model/aggregate.md
table-design/data-partitioning/data-bucketing.md
table-design/data-partitioning/manual-partitioning.md
table-design/data-partitioning/dynamic-partitioning.md
table-design/data-partitioning/auto-partitioning.md
data-operate/update/partial-column-update.md
data-operate/update/unique-update-concurrent-control.md
data-operate/update/multi-stream-update-for-unique-model.md
data-operate/delete/batch-delete-manual.md
data-operate/import/import-way/stream-load-manual.md
data-operate/import/import-way/routine-load-manual.md
data-operate/import/load-best-practices/group-commit-manual.md
data-operate/import/load-best-practices/load-best-practices.md
data-operate/import/load-best-practices/routine-load-best-practices.md
data-operate/transaction.md
connection-integration/data-integration/flink-doris-connector.md
table-design/schema-change.md
table-design/index/index-overview.md
table-design/index/inverted-index/overview.md
table-design/index/prefix-index.md
table-design/index/vector-index/overview.md
query-acceleration/query-profile.md
query-acceleration/optimization-technology-principle/statistics.md
query-acceleration/colocation-join.md
query-acceleration/materialized-view/async-materialized-view/overview.md
query-acceleration/materialized-view/sync-materialized-view.md
admin-manual/workload-management/workload-group.md
admin-manual/workload-management/spill-disk.md
admin-manual/trouble-shooting/compaction.md
admin-manual/data-admin/backup-restore/overview.md
admin-manual/auth/security-overview.md
admin-manual/cluster-management/upgrade.md
install/choosing-deployment-mode.md
install/preparation/cluster-planning.md
lakehouse/catalog-overview.md
lakehouse/best-practices/optimization.md
sql-manual/basic-element/sql-data-types/semi-structured/VARIANT.md'''.splitlines()
available = set((root / 'doc-paths.txt').read_text().splitlines())
paths = ['versioned_docs/version-4.x/' + p for p in paths]
paths += [p for p in available if p.startswith('releasenotes/v4.1/') and p.endswith('.md')]

def fetch(path):
    if path not in available:
        return {'path': path, 'error': 'not in tree'}
    url = 'https://raw.githubusercontent.com/apache/doris-website/master/' + path
    try:
        with urllib.request.urlopen(url, timeout=45) as response:
            data = response.read()
        target = root / 'sources' / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        return {'path': path, 'url': url, 'bytes': len(data)}
    except Exception as error:
        return {'path': path, 'error': str(error)}

with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
    result = list(pool.map(fetch, paths))
(root / 'manifest.json').write_text(json.dumps(result, indent=2))
print(json.dumps({'downloaded': sum('bytes' in x for x in result), 'errors': [x for x in result if 'error' in x]}, indent=2))
