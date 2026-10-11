#!/usr/bin/env python3
"""File docs/ux-audit/05-backlog.md as GitHub issues: tracker -> epics -> sub-issues.

Usage: python3 scripts/redesign/file-backlog.py [--dry-run]
Resumable: docs/ux-audit/issue-map.json maps backlog id -> issue number/id; mapped ids are skipped.
Sub-issues link by the child's database `id` (docs.github.com/en/rest/issues/sub-issues).
"""
import json, re, subprocess, sys, time, os

REPO = "iammorganparry/jingler"
SRC = "docs/ux-audit/05-backlog.md"
MAP = "docs/ux-audit/issue-map.json"
DRY = "--dry-run" in sys.argv
PAPER = "https://app.paper.design/file/01M4K9KPAEC70CQCJ6P8MPARJN"
FOOTER = (
    "\n\n---\n**Redesign rules** (see `AGENTS.md`):\n"
    "- Branch from and open the PR into `epic/redesign`. One issue = one PR.\n"
    "- Build only from the cataloged components in `packages/ui/COMPONENTS.md`. A missing atom/molecule is added "
    "to `packages/ui` and the catalog first (its own PR), never inlined in a view.\n"
    "- Every view/state gets a Storybook story and is compared side by side with its Paper board for visual parity; "
    "attach both screenshots to the PR.\n"
    "- No hardcoded colours (`--sb-*` tokens); 3+ coupled renderer state → XState `*-machine.ts` + test; "
    "user-facing features ship a Playwright e2e.\n"
    f"- Boards: {PAPER} (page \"02 · Improved\"). Spec: `docs/ux-audit/03-redesign-spec.md`. "
    "Line numbers drift; re-check before starting."
)


def gh(*args, input=None):
    for attempt in range(5):
        r = subprocess.run(["gh", *args], input=input, capture_output=True, text=True)
        if r.returncode == 0:
            return r.stdout
        if "rate limit" in r.stderr.lower() or "secondary" in r.stderr.lower():
            time.sleep(60 * (attempt + 1)); continue
        raise SystemExit(f"gh {' '.join(args[:3])} failed: {r.stderr}")
    raise SystemExit("gh: rate limited too many times")


def create(title, body, labels):
    d = json.loads(gh("api", f"repos/{REPO}/issues", "--input", "-",
                      input=json.dumps({"title": title, "body": body + FOOTER, "labels": labels})))
    time.sleep(1.2)  # content-creation secondary limit
    return d["number"], d["id"]


def link(parent_no, child_db_id):
    gh("api", "-X", "POST", f"repos/{REPO}/issues/{parent_no}/sub_issues", "-F", f"sub_issue_id={child_db_id}")


epics, cur = [], None
for block in re.split(r"(?m)^(?=## |### )", open(SRC).read()):
    if m := re.match(r"## Epic (\d+) — (.+)", block):
        cur = {"id": m[1], "title": m[2].strip(), "subs": []}; epics.append(cur)
    elif (m := re.match(r"### (\d+\.\d+) (.+)", block)) and cur:
        body = re.split(r"(?m)^---\s*$", block.split("\n", 1)[1].strip())[0].strip()
        t = re.search(r"\*\*Type:\*\* ([a-z-]+)", body)
        cur["subs"].append({"id": m[1], "title": m[2].strip(), "body": body, "type": t[1] if t else "feature"})
    elif block.startswith("## "):
        cur = None

print(f"{len(epics)} epics, {sum(len(e['subs']) for e in epics)} sub-issues")
if DRY:
    for e in epics:
        print(f"  Epic {e['id']}: {e['title']} ({len(e['subs'])})")
    sys.exit(0)

for name, color in [("redesign", "ef3f57"), ("epic", "5319e7"), ("type: component", "1d76db"),
                    ("type: feature", "0e8a16"), ("type: bug", "d73a4a"), ("type: style", "c5def5"),
                    ("type: data-model", "fbca04"), ("decision pending", "b60205")]:
    subprocess.run(["gh", "label", "create", name, "-R", REPO, "-c", color, "-f"], capture_output=True)

m = json.load(open(MAP)) if os.path.exists(MAP) else {}
def save(): json.dump(m, open(MAP, "w"), indent=1, sort_keys=True)

if "tracker" not in m:
    n, i = create("Redesign: epic stack (tracker)",
                  "Tracks the Jingler redesign. Every PR targets `epic/redesign`; that branch merges to `main` when "
                  "the epics below are done.\n\nSource of truth: `docs/ux-audit/05-backlog.md` (build order, "
                  "decisions D1–D4), `docs/ux-audit/03-redesign-spec.md`.", ["redesign", "epic"])
    m["tracker"] = {"number": n, "id": i}; save()

for e in epics:
    key = f"epic-{e['id']}"
    if key not in m:
        rows = "\n".join(f"- {s['id']} {s['title']}" for s in e["subs"])
        n, i = create(f"Epic {e['id']}: {e['title']}",
                      f"Epic {e['id']} of the redesign. Each sub-issue is one PR into `epic/redesign`.\n\n{rows}",
                      ["redesign", "epic"])
        m[key] = {"number": n, "id": i}; save()
        link(m["tracker"]["number"], i)
    for s in e["subs"]:
        if s["id"] in m:
            continue
        labels = ["redesign", f"type: {s['type']}"] + (["decision pending"] if "**Decision pending:** D4" in s["body"] else [])
        n, i = create(f"[{s['id']}] {s['title']}", s["body"], labels)
        m[s["id"]] = {"number": n, "id": i}; save()
        link(m[key]["number"], i)
        print(f"{s['id']} -> #{n}", flush=True)

# Second pass: rewrite "Depends on: 1.1, 2.4" as issue links.
for e in epics:
    for s in e["subs"]:
        dep = re.search(r"\*\*Depends on:\*\* (.+)", s["body"])
        if not dep or m[s["id"]].get("deps"):
            continue
        refs = [f"#{m[x]['number']} ({x})" for x in re.findall(r"\b\d+\.\d+\b", dep[1]) if x in m]
        if refs:
            gh("api", "-X", "PATCH", f"repos/{REPO}/issues/{m[s['id']]['number']}", "--input", "-",
               input=json.dumps({"body": s["body"].replace(dep[0], f"**Depends on:** {', '.join(refs)}") + FOOTER}))
            time.sleep(0.5)
        m[s["id"]]["deps"] = True; save()
print("done")
