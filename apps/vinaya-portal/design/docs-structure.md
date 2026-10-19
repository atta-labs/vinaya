# Web docs structure

Revision 2, 2026-10-17. Revision 1 reviewed against Linear; every review point is applied below. Linear initiatives carry no numbers: a child is named `Parent › Child`. The numbers in this file are only an index for ordering.

## Principles

1. **Linear is the skeleton.** Every Linear initiative under `1 · Vinaya Development Harness` has exactly one docs page, with Linear's exact name (the part after `›`) and parent. This includes 1 and 1.1.
2. **Reader pages are presentation, not scope.** Pages Linear does not have (getting started, guides, references, glossary) are allowed when a reader needs them. They never become Linear initiatives.
3. **One name per thing.** A feature has the same name in Linear, the Product menu and the docs. No two docs pages share a title.
4. **Tabs follow Linear.** The docs landing page is 1. Its two children are the two tabs: **Features** (1.1) and **The Vinaya process** (1.2).
5. **Status is a badge.** Set by the rule in [Badges](#badges), allowed on pages, child pages and sections.

## The tree

`/docs` is the landing page (= 1): one paragraph and two cards, Features and The Vinaya process.

### Tab 1 · Features (`/docs/features`)

| Group | Docs page | Route | Linear |
| --- | --- | --- | --- |
| Start | Overview | `/overview` | 1.1 |
| Start | Get started | `/get-started` | reader page |
| Features | **Log** | `/log` | 1.1.1 |
| | ↳ Event contract | `/log/event-contract` | 1.1.1.1 |
| | ↳ Delivery | `/log/delivery` | 1.1.1.2 |
| | ↳ Custom events | `/log/custom-events` | 1.1.1.3 |
| | ↳ Reading back | `/log/reading-back` | 1.1.1.4 |
| | ↳ Redaction and trust | `/log/redaction-and-trust` | 1.1.1.5 |
| Features | **Studio** | `/studio` | 1.1.2 |
| | ↳ Mission Control | `/studio/mission-control` | 1.1.2.1 |
| | ↳ Dashboard and statistics | `/studio/dashboard-and-statistics` | 1.1.2.2 |
| | ↳ Many repositories | `/studio/many-repositories` | 1.1.2.3 |
| Features | **Dev Process** | `/dev-process` | 1.1.3 |
| | ↳ Process contract (with a **Generic gates** section) | `/dev-process/process-contract` | 1.1.3.1 |
| | ↳ Adapters | `/dev-process/adapters` | 1.1.3.2 |
| | ↳ Loader | `/dev-process/loader` | 1.1.3.3 |
| | ↳ Conformance | `/dev-process/conformance` | 1.1.3.4 |
| Features | **Self-improvement** | `/self-improvement` | 1.1.4 |
| Features | **Configuration** | `/configuration` | 1.1.5 |
| | ↳ The file and its keys | `/configuration/the-file-and-its-keys` | 1.1.5.1 |
| | ↳ Trust | `/configuration/trust` | 1.1.5.2 |
| | ↳ Setup commands | `/configuration/setup-commands` | 1.1.5.3 |
| Reference | CLI | `/cli` | reader page |

### Tab 2 · The Vinaya process (`/docs/process`)

| Group | Docs page | Route | Linear |
| --- | --- | --- | --- |
| Start | Overview | `/overview` | 1.2 |
| Guides | Start from a Goal | `/guides/from-a-goal` | reader page (demo: Complex work) |
| Guides | Start from a tranche | `/guides/from-a-tranche` | reader page (demo: Medium work) |
| Guides | Start from one Issue | `/guides/from-one-issue` | reader page (demo: Simple task) |
| Guides | Fix something now (hot) | `/guides/hot-issue` | reader page (demo: Hot issue) |
| Parts | **Thinking** | `/thinking` | 1.2.1 |
| | ↳ Goals and milestones | `/thinking/goals-and-milestones` | 1.2.1.1 |
| | ↳ Tranches and tasks | `/thinking/tranches-and-tasks` | 1.2.1.2 |
| | ↳ Issue kinds | `/thinking/issue-kinds` | 1.2.1.3 |
| | ↳ Readiness and the frozen brief | `/thinking/readiness-and-frozen-brief` | 1.2.1.4 |
| Parts | **Executing** | `/executing` | 1.2.2 |
| | ↳ The loop | `/executing/the-loop` | 1.2.2.1 |
| | ↳ Batches | `/executing/batches` | 1.2.2.2 |
| | ↳ Hot mode | `/executing/hot-mode` | 1.2.2.3 |
| | ↳ The Operator | `/executing/the-operator` | 1.2.2.4 |
| | ↳ Pauses and rulings | `/executing/pauses-and-rulings` | 1.2.2.5 |
| | ↳ Parent and integration branches | `/executing/parent-and-integration-branches` | 1.2.2.6 |
| Parts | **Retrospecting** | `/retrospecting` | 1.2.3 |
| | ↳ Task close | `/retrospecting/task-close` | 1.2.3.1 |
| | ↳ Tranche and Milestone close | `/retrospecting/tranche-and-milestone-close` | 1.2.3.2 |
| | ↳ Ring 2 audits | `/retrospecting/ring2-audits` | 1.2.3.3 |
| Parts | **Gates** | `/gates` | 1.2.4 |
| | ↳ Ring 0 commit checks | `/gates/ring0-commit-checks` | 1.2.4.1 |
| | ↳ Ring 0 push checks | `/gates/ring0-push-checks` | 1.2.4.2 |
| | ↳ Ring 1 pull request checks | `/gates/ring1-pull-request-checks` | 1.2.4.3 |
| | ↳ Ring 1 Issue checks | `/gates/ring1-issue-checks` | 1.2.4.4 |
| | ↳ Mechanisms outside the registry | `/gates/mechanisms-outside-the-registry` | 1.2.4.5 |
| Reference | Roles | `/roles` | reader page |
| Reference | Checks catalog | `/checks` | reader page: all 39, filter by ring and by generic or Vinaya-specific |
| Reference | Events | `/events` | reader page: the "Vinaya Log — event reference" document on 1.2 |
| Reference | Vinaya keys | `/vinaya-keys` | reader page: the Vinaya keys of the config file |
| Reference | Glossary | `/glossary` | reader page: Intent, Run, Surface, tranche, ruling, frozen brief, the nine derived statuses, and the rest |

"Working with it" is replaced by the four guides, one per way work enters (Linear 1.2 §11: a Goal, a tranche, one Issue; plus hot). Each guide links its `/vinaya-process/demo` flow.

## Cross-links

- **Generic gates ↔ Gates.** Process contract's Generic gates section (12 families, result contract, 4 enforcement points) links to Gates; Gates links back. Ring 0 = enforcement points 1–2, Ring 1 = point 3, Ring 2 = point 4.
- **Events ↔ Event contract.** The Events table maps each Vinaya event to its generic family and links to 1.1.1.1.
- **Roles.** Links each role to its page (the Operator to 1.2.2.4). Says the Improver is a harness agent and links to Self-improvement.

## Page templates

| Page kind | Sections |
| --- | --- |
| Landing (1) | One paragraph · two cards |
| Overview (1.1, 1.2) | What it is · how it fits · cards for every child |
| Feature or part | What it is · How it works · Configuration · What gets logged · Troubleshooting · cards for children · What's next |
| Child page | What it is · How it works · Examples · Configuration · What's next |
| Guide | Before you start · Steps · What you get · What's next |
| Reference | One table or card per item, grouped, filterable where long |

Every page head: section label, title, one-line summary, badges.

## Badges

| Badge | Means | Set by |
| --- | --- | --- |
| Shipped | In the released package and works as the page describes | Default when no other badge applies |
| Partial | Part of the page is shipped; the rest is marked per section | A section-level `Planned` badge exists on the page |
| Planned | Defined in Linear, not in the released package | The engineering status list says not built |
| Draft | The page states a rule Linear still lists as an open Principal decision | An open item in Linear 1.2 Part III |

One status list (`src/content/docs-status.ts`) holds every page's and section's badge, so status is reviewed in one place each release. Badges go on pages, child pages and sections.

Known today: Self-improvement `Planned`; Execution Planner section `Planned`; `vinaya.planning.*` and `vinaya.closeout.*` events `Planned`; Many repositories to verify; Hot mode, Issue kinds, Parent and integration branches `Draft` until Part III is settled.

## For agents

- `/llms.txt`: the docs tree with one line per page, generated from the nav.
- Copy page (exists) and ⌘K search (exists).

## Decisions

| Decision | Outcome |
| --- | --- |
| Name of 1.1.3 | **Dev Process** everywhere. Needs Linear's own document title and Features table to change from "Development Process" in the same pass. |
| Self-improvement page | Add now, `Planned` |
| Overview pages | 1.2 is the process Overview; 1.1 is the Features Overview; 1 is the `/docs` landing |
| Gates | Process tab only; `/docs/harness/gates` redirects to `/docs/process/gates` |
| Event reference | Stays a document on 1.2, shown as the Events reference page |
| Reader pages | Never Linear initiatives |

## Linear follow-ups (outside the site)

1. Rename the 1.1.3 document and the Features table entry to "Dev Process".
2. Settle the open Part III decisions so `Draft` badges can go.
