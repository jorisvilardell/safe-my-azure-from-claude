---
name: Feature slice
about: A new read-only capability (one folder under src/features/)
labels: feature
---

## Capability

<!-- What question does this help the on-call human answer? -->

## Tools

| Tool | Inputs (names/aliases only) | Output DTO fields (allowlist) |
| ---- | --------------------------- | ----------------------------- |

## Azure APIs (read-only)

<!-- SDK package + operation. Must be GET / query only. -->

## Anonymisation notes

<!-- Which fields could leak IDs, emails, IPs, secrets? -->

## Definition of Done

- [ ] Follows the feature layout in AGENTS.md §2
- [ ] Leak tests with fake payloads
- [ ] Registered in `src/app/features.ts`
- [ ] `npm run check` green
