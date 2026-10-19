# Brief: rewrite the hand-written docs pages as Markdown

Nine docs pages are still TSX (`src/app/(site)/docs/(guide)/<group>/<slug>/page.tsx`). Rewrite each as one Markdown file in `src/content/docs-tree/`, following `design/docs-writing-guide.md` exactly. Model page: `src/content/docs-tree/1.2.4-gates.md`. Do NOT touch TSX, nav or any other file; the lead wires the routes and deletes the TSX afterwards.

| Page (route) | Current TSX | Write to | Kind |
| --- | --- | --- | --- |
| Get started (/docs/features/get-started) | features/get-started/page.tsx | 1.1.0-get-started.md | child-like page, task-first |
| Log (/docs/features/log) | features/log/page.tsx | 1.1.1-log.md | feature page with children 1.1.1.1–1.1.1.5 |
| Dev Process (/docs/features/dev-process) | features/dev-process/page.tsx | 1.1.3-dev-process.md | feature page with children 1.1.3.1–1.1.3.4 |
| Configuration (/docs/features/configuration) | features/configuration/page.tsx | 1.1.5-configuration.md | feature page with children 1.1.5.1–1.1.5.3 |
| CLI (/docs/features/cli) | features/cli/page.tsx | 1.1.6-cli.md | reference page |
| Overview (/docs/process/overview) | process/overview/page.tsx | 1.2-overview.md | part-like page with the four parts as cards |
| Roles (/docs/process/roles) | process/roles/page.tsx | 1.2.5-roles.md | reference page |
| Working with it (/docs/process/working-with-it) | process/working-with-it/page.tsx | 1.2.6-working-with-it.md | how-to page |
| Vinaya keys (/docs/process/vinaya-keys) | process/vinaya-keys/page.tsx | 1.2.7-vinaya-keys.md | reference page |

Header lines: `# <number> · <Name> — definition` (for the overview: `# 1.2 · The Vinaya process — overview`), then `Summary:`, `Parent:`, optional `Badges:`.

## Where facts may come from

The TSX pages are thin, so you may also take facts (never invent) from:
- the child pages of that page in `src/content/docs-tree/` (summarise them; link down, don't copy them whole);
- `/Users/daniboomerang/Work/Repositories/Me/atta-labs/vinaya/docs/drafts/development-process-product-definition-v2.md` (generic contract, harness features);
- `/Users/daniboomerang/Work/Repositories/Me/atta-labs/vinaya/docs/drafts/vinaya-process-definition-v3.md` (the Vinaya process: parts, roles, keys §19, commands);
- `/Users/daniboomerang/Work/Repositories/Me/atta-labs/vinaya/docs/drafts/vinaya-log-and-config-draft.md`;
- for Roles: the role and hand-off docs the TSX loads via `loadAegDocs` (`src/lib/docs/load-aeg-docs.ts`; find the aeg docs root it reads, the sections whose labels contain "role" and "contract").
Read only; never edit those files. Where sources disagree, the v3/v2 drafts win over the TSX.

## Decided product facts (do not contradict)

- Features: Log, Studio, Dev Process, Self-improvement, Configuration. The Vinaya process parts: Thinking, Executing, Retrospecting, Gates. There is no "Planning" stage of its own (planning is inside Thinking) and Self-improvement is NOT a process stage: it is a harness feature (the Improver agent proposes, the Principal approves). Retrospecting is closing out (task, tranche, milestone close, Ring 2 audits) and has no link to self-improvement.
- Gates are part of the Vinaya process; the generic gate families are defined in the Dev Process feature (process contract).
- Studio is a harness feature that reads the Log.

## Generated reference blocks (use them; do not hand-write command or key lists)

- ```` ```commands ```` with one CLI command name per line renders the full command reference (synopsis, description, flags) from source. Names available: quickstart, init, upgrade, doctor, eject, check, new check, new noop-check, waiver, audit, log selftest, log emit, log send, sync, demo break, help, version, studio, pr rule.
- ```` ```config-keys ```` with `harness`, `process`, or individual top-level key names, one per line, renders the key reference from source. Harness keys: logs, runtimeDir, dispatch, principals, releaseActor, managed, ci, tokens. Process keys: roles, briefSchema, reviewPolicy, planning, projects, blastRadius, checks, rings, prePush, securityScan, gateCutovers, proseGates, decisionRecords, report.

CLI page: group the commands under h2s (Install and maintain · Gates · Log · Try it and help), each a `commands` block; say the Vinaya process adds `studio` and `pr rule` and link Working with it. Configuration: overview + how it works + a `config-keys` block with `harness`. Vinaya keys: intro + `config-keys` with `process`. Get started / Log / Working with it: use `commands` blocks for their commands.

## Links

Only routes in `src/app/(site)/docs/_lib/portal-docs.ts` DOCS_NAV, `/vinaya-process/demo/<complex|medium|simple|hot>`, plus `/start/quick` (the quick start). No other site routes.

## Done when

The file exists, follows the guide, keeps every fact of the TSX page (except ones the decided facts above override), invents nothing, no source paths/ADR/section numbers/status prose. Report in 3 lines: files written, any fact you dropped and why.
