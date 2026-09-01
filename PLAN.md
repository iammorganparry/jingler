# Fix Plannotator approval continuation

## Reproduce the live approval flow
- [x] Submit this plan through the real Plannotator review surface.
- [x] Approve it and record whether the embedded view returns to the plan and this agent resumes.

### Acceptance
- [x] The failure is reproduced through the same path the operator uses.

## Fix the root cause
- [x] Trace the decision from the embedded approval request through renderer, runtime, and the waiting Plannotator tool.
- [x] Fix the first incorrect state transition or missing acknowledgement.

### Acceptance
- [x] Approval reaches the exact pending review once.
- [x] The agent resumes without a manual message.
- [x] Plannotator shows the live plan after approval.

## Verify end to end
- [x] Add the smallest regression checks for the reproduced failure.
- [x] Run focused unit, typecheck, and Electron tests.
- [x] Submit a fresh live Plannotator review and verify approval again.

### Acceptance
- [x] The live approval flow works twice: reproduction and post-fix verification.
- [x] Automated checks pass.
