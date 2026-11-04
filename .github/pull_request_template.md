## What & why

## Feature / scope

- [ ] `core/` change
- [ ] Feature: `src/features/<name>/`

## Security checklist (AGENTS.md §3)

- [ ] New tools use `defineTool()` (no direct `registerTool`)
- [ ] Mapper is an allowlist (no `...raw` spread)
- [ ] Inputs use names/aliases, not IDs
- [ ] Tests include fake GUIDs/ARM IDs/emails/JWTs and assert `expectNoLeak()`
- [ ] Read-only: no write/action API call added
- [ ] No real tenant/subscription/resource identifiers in code, tests, or docs

## Verification

- [ ] `npm run check` passes
