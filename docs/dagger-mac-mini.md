# Running the Dagger checks on the Mac mini

The `ci` Dagger module (`.dagger/modules/ci`) runs the Linux-safe CI checks in
containers: `ci/lint`, `ci/typecheck`, `ci/test`, `ci/pi-eval`, `ci/licenses`.
After the first run the engine caches the install layer, so re-running an
unchanged check takes seconds. Measured on clive: lint took 15m51s cold
(a fresh `pnpm install` inside the engine) and 3s warm.

## Run it

Push your branch, then from any worktree:

```sh
scripts/dagger-mini.sh                      # every check, current branch
scripts/dagger-mini.sh fix/foo ci/lint      # one check, named branch
```

The script SSHes to `clivetrigify@clive.local` (override with `DAGGER_MINI`),
fetches `origin/<branch>` into `~/dagger-ci/wt/<branch>` and runs
`dagger check`. It builds what is pushed, not your local edits.

To run the same checks on your own machine instead: `dagger check ci/lint`
from the repo root.

## What is on clive

- Dagger `v1.0.0-beta.22` at `~/.local/bin/dagger`. Keep it on the beta: the
  module needs features stable v0.21 lacks.
- Docker Desktop, CLI at `/Applications/Docker.app/Contents/Resources/bin`,
  VM with 10 CPUs and 8 GB. `ci/typecheck` uses `turbo --concurrency=2` so it
  fits in that memory.
- A clone at `~/dagger-ci/repo` that the script adds worktrees to.

## Limits

- **Disk.** clive has a 228 GB disk shared with the jingler, trigify, gtmgrid
  and smuggler GitHub runners and other Docker containers. The engine cache
  lives in Docker's VM disk. Check `df -h ~` before a cold run; if free space
  is under 15 GB, don't start one.
- **One run at a time.** Parallel cold runs compete for the 8 GB VM.
- **Docker hangs.** If `docker info` fails or times out, Docker Desktop's VM
  is wedged. Restarting it (`osascript -e 'quit app "Docker"'; open -a Docker`)
  also restarts every other container on the machine, so ask first.
