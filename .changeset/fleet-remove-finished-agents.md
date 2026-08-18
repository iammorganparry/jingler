---
"@jingler/cli-adapters": patch
---

Remove finished agents from the Fleet dock. A run whose process ended without a completion event settled to UNKNOWN and then sat in the Fleet forever — sessions accumulated rows of grey dead workers. The process-terminal handler now publishes the settled state (so the completed-agents retention still captures it, transcript included) and then removes the run's nodes, and the refresh pass sweeps any finished node (completed, failed, stopped, or unknown) that re-enters the tree. The dock shows live work; finished output stays reachable through completion links and retention.
