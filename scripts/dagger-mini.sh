#!/bin/sh
# Run the Dagger `ci` checks for a pushed branch on the Mac mini (clive.local).
# Usage: scripts/dagger-mini.sh [branch] [check ...]   e.g. scripts/dagger-mini.sh fix/foo ci/lint ci/typecheck
# Branch defaults to the current one; no checks = all of them. Push first: the mini builds origin/<branch>.
set -e
branch=${1:-$(git branch --show-current)}
[ $# -gt 0 ] && shift
host=${DAGGER_MINI:-clivetrigify@clive.local}
ssh -o BatchMode=yes -o ConnectTimeout=8 "$host" sh -s "$branch" "$@" <<'EOF'
set -e
export PATH=/Applications/Docker.app/Contents/Resources/bin:$HOME/.local/bin:$PATH
branch=$1; shift
repo=$HOME/dagger-ci/repo
dir=$HOME/dagger-ci/wt/$(echo "$branch" | tr / -)
docker info >/dev/null 2>&1 || { echo "Docker Desktop on the mini is down: quit and reopen it (open -a Docker)"; exit 1; }
git -C "$repo" fetch -q origin "$branch"
[ -d "$dir" ] || git -C "$repo" worktree add -q --detach "$dir" "origin/$branch"
git -C "$dir" checkout -q --detach "origin/$branch"
cd "$dir" && dagger check "$@"
EOF
