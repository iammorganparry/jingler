---
description: Use when implementing or reviewing authentication, authorization, secrets, payments, dependency updates, or other security-sensitive code; requires threat-focused evidence and an appropriate local scanner when available.
---

# Security review

1. Identify the trust boundary, protected asset, attacker-controlled inputs, and authorization decision.
2. Trace every caller of changed shared security logic before editing.
3. Check validation, authentication vs authorization, secret exposure, injection, replay, and failure behavior.
4. Use `security_scan` availability first; run one relevant installed scanner only when its findings apply to the change.
5. Report exact file/line evidence, scanner prerequisites, and unresolved risk. Never treat a clean scanner as proof of safety.
