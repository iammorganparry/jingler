import concurrent.futures
import json
import pathlib
import re
import urllib.request
import yaml

root = pathlib.Path('.jingler/doris-skill/apache-doris')
files = list(root.rglob('*.md'))
errors = []
urls = set()
local_links = 0
frontmatter = yaml.safe_load((root / 'SKILL.md').read_text().split('---', 2)[1])
assert set(frontmatter) == {'name', 'description'}
assert frontmatter['name'] == root.name
assert len((root / 'SKILL.md').read_text().splitlines()) < 500
for file in files:
    text = file.read_text()
    if text.count('```') % 2:
        errors.append(f'{file}: unbalanced fences')
    if len(text.splitlines()) > 100 and '## Contents' not in text:
        errors.append(f'{file}: missing contents')
    for label, target in re.findall(r'\[([^\]]*)\]\(([^)]+)\)', text):
        if target.startswith('https://'):
            urls.add(target)
        elif not target.startswith('#'):
            local_links += 1
            if not (file.parent / target.split('#')[0]).is_file():
                errors.append(f'{file}: broken local link {target}')
    if re.search(r'\b(TODO|FIXME)\b', text):
        errors.append(f'{file}: placeholder')

# Pinned GitHub links were checked against downloaded Git tree blob hashes separately.
live = sorted(u for u in urls if not '/blob/' in u and not '/tree/' in u)
def check(url):
    try:
        request = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(request, timeout=40) as response:
            content = response.read().decode('utf-8', errors='replace')
            title_match = re.search(r'<title>(.*?)</title>', content, re.S)
            title = title_match.group(1) if title_match else ''
            if 'Page Not Found' in title or '404' in title:
                return {'url': url, 'error': title}
            return {'url': url, 'status': response.status, 'final_url': response.url, 'title': title}
    except Exception as error:
        return {'url': url, 'error': str(error)}

with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
    results = list(pool.map(check, live))
errors.extend(x for x in results if 'error' in x)
report = {'markdown_files': len(files), 'local_links': local_links, 'unique_external_links': len(urls), 'live_urls_checked': len(live), 'errors': errors, 'urls': results}
pathlib.Path('.jingler/doris-research/validation-report.json').write_text(json.dumps(report, indent=2))
print(json.dumps({k: v for k, v in report.items() if k != 'urls'}, indent=2))
raise SystemExit(bool(errors))
