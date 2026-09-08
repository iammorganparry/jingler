# Measured CI test parallelism

- [x] Measure full Vitest execution before changing CI.
- [x] Compare bounded sharding with the existing worker-limit setting.
- [x] Operator chose four workers without sharding; remove the experimental runner and its tests.
- [x] Verify the exact CI test command plus full lint and typecheck before pushing.

Final local verification: `VITEST_MAX_WORKERS=4 pnpm test` passed all 4,684 tests (4,423 root Vitest tests plus 261 tests across the four separate suites). The root run took 124.9s. Full `pnpm lint` passed with warnings; full `pnpm typecheck` passed across 23 tasks using CI's placeholder environment values.

Local measurements (Node 22.14.0, Vitest 3.2.7, 11 CPUs / 18GiB RAM):

| Execution | Wall time | Result |
| --- | ---: | --- |
| Existing two-worker default | 194.8s | 4,423 passed |
| Two shards × one worker | 225.5s | 4,427 passed |
| Two shards × two workers | 133.0s | 4,427 passed |
| One process × four workers | 118.1s | 4,427 passed |

The four extra tests validated the experimental shard runner and were removed with it. Runs were sequential, not controlled repeated benchmarks; four workers measured about 39% faster than the baseline, but CI gains are not yet measured. `/usr/bin/time -l` reported zero swaps; its maximum RSS is not an aggregate of all test processes.

Only CI's Test step sets `VITEST_MAX_WORKERS=4`. Local defaults remain two workers, isolation stays enabled, and the four separate Cloudflare suites in `pnpm test` remain unchanged. No new dependencies or sharding infrastructure.

Official version-matched reference: https://v3.vitest.dev/guide/improving-performance#sharding

The earlier CI install failure was npm ECONNRESET; its retry passed. Test parallelism does not fix runner setup/download delays. PR #283 must pass again at the new head before merge. No GitHub feedback comments will be posted.
