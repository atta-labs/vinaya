# Information architecture — Product and Docs

Draft, 2026-10-17. Aligns the portal with the Linear structure decided this week.

## 1. The model the site must show

```text
Harness (the product)                         The Vinaya process (the default process)
  1.1.1 Log                                     1.2.1 Thinking
  1.1.2 Studio                                  1.2.2 Executing
  1.1.3 Dev Process  ── the socket ──────────▶  1.2.3 Retrospecting
  1.1.4 Self-improvement                        1.2.4 Gates
  1.1.5 Configuration
```

Rules the UI must not break:

- Gates are not a harness feature. Generic gates are part of the Dev Process contract; the 39 checks belong to the Vinaya process.
- Self-improvement is a harness feature. The Improver proposes; the Principal approves. On Vinaya pages it may appear as "Stage 4" of the story, with the Improver as actor.
- Retrospecting is archiving. It has no link to self-improvement.
- The Operator only operates. The Principal approves the plan, rules and merges.
- The Log is never control state and never written to GitHub.

## 2. Top navigation

| Item | Today | Proposed |
| --- | --- | --- |
| Product ▾ | Configuration, Gates, Log, Studio, Dev Process | **Log, Studio, Dev Process, Self-improvement, Configuration** (Linear order). Gates removed. |
| The Vinaya process | `/vinaya-process` | Same. Its page gets a Gates section. |
| Docs ▾ | Harness · The Vinaya process | Same two groups, rebuilt to mirror Linear (§4). |
| Start | `/start` | Same. |

Product menu copy:

| Item | Line |
| --- | --- |
| Log | Every governed act, written down live. |
| Studio | A live view of every run, check and review. |
| Dev Process | Bring your own process, or use the Vinaya process. |
| Self-improvement | The Log turns runs into proposals; you approve them. |
| Configuration | One file says how your repository is governed. |

Docs menu copy:

| Item | Line |
| --- | --- |
| Harness | Get started, the Log, Studio, your own process, self-improvement, configuration, the CLI. |
| The Vinaya process | Thinking, Executing, Retrospecting, the gates, the events, its configuration. |

## 3. Product pages (marketing, one per harness feature)

One shared template, so the five pages read as a set:

1. **Hero** — one sentence of what it is and one of why it matters.
2. **What you get** — three to four cards.
3. **How it works** — one diagram or live component.
4. **The promise** — what the harness guarantees here, and the honest limit.
5. **With the Vinaya process** — how the default process uses this feature, linking to `/vinaya-process`.
6. **Next** — link to the matching Docs section.

| Page | Route | Hero idea | How it works | Promise / limit |
| --- | --- | --- | --- | --- |
| Log | `/product/log` | Every governed act, typed and attributed, delivered live where you say. | Event stream: a run's events flowing into a folder or server | Never on GitHub, never decides a run. Telemetry loss is visible, never hidden. |
| Studio | `/the-studio` → `/product/studio` | See every run, pause and gate as it happens. | Mission Control mock (already built) | Studio reads; it never decides. |
| Dev Process | `/product/dev-process` | Bring your own process; the guarantees stay the same. | Socket diagram: process package ↔ harness ↔ adapters | Same guarantees for any conforming process; unsupported shapes refused. |
| Self-improvement | `/product/self-improvement` (new) | The Log turns runs into proposals. You approve them. | Report → Improver → proposal → Principal → new version | Never rewrites a process silently; runs in flight stay pinned. Marked as coming. |
| Configuration | `/product/configuration` | One file, read safely. | The config board (already built), with harness vs process keys | Never loads code; key rules read from the default branch. |

`/product/gates` moves out of Product: redirect to `/vinaya-process#gates`.

## 4. Docs (reference, mirrors Linear one to one)

The docs tree is the Linear tree. Each Linear initiative is a docs page; each sub-initiative is a page or an anchored section. Content source: the drafts in `atta-labs/vinaya/docs/drafts/tree/`.

### Harness

| Page | Route | Sections (from the Linear sub-initiatives) |
| --- | --- | --- |
| Get started | `/docs/harness/get-started` | Install, upgrade, check, remove |
| Log | `/docs/harness/log` | Event contract · Delivery · Custom events · Reading back · Redaction and trust |
| Studio | `/docs/harness/studio` (new) | Mission Control · Dashboard and statistics · Many repositories |
| Your own process | `/docs/harness/your-own-process` | Process contract · Adapters · Loader · Conformance |
| Self-improvement | `/docs/harness/self-improvement` (new) | What it will do; marked planned |
| Configuration | `/docs/harness/configuration` | The file and its keys · Trust · Setup commands |
| CLI | `/docs/harness/cli` | Generated from the command list |

`/docs/harness/gates` moves to the process group (redirect).

### The Vinaya process

| Page | Route | Sections |
| --- | --- | --- |
| Overview | `/docs/process/overview` | The three parts, the four kinds of work, the Principal's decisions |
| Thinking | `/docs/process/thinking` (new) | Goals and Milestones · Tranches and tasks · Issue kinds · Readiness and the frozen brief |
| Executing | `/docs/process/executing` (new) | The loop · Batches · Hot mode · The Operator · Pauses and rulings · Parent and integration branches |
| Retrospecting | `/docs/process/retrospecting` (new) | Task close · Tranche and Milestone close · Ring 2 audits |
| Gates | `/docs/process/gates` (moved) | Rings · Ring 0 commit · Ring 0 push · Ring 1 pull request · Ring 1 Issue · Mechanisms outside the registry. One card per check, all 39. |
| Events | `/docs/process/events` (new) | Header fields · every family and event · generic mapping · not emitted yet |
| Roles | `/docs/process/roles` | Keep |
| Working with it | `/docs/process/working-with-it` | Keep |
| Configuration | `/docs/process/configuration` | Vinaya keys (v3 §19) |

Every part page uses the same sections: What it is · Roles · Flow · Gates · Logging · Settings. A reader always finds "what is logged here" in the same place.

### Docs components needed

| Component | Use |
| --- | --- |
| Check card | One per gate: refuses, ring and when, reads, outcomes, implements, settings, source. Filter by ring and by generic/Vinaya. |
| Event card | One per Log event: when it fires, fields, generic family, emitting part. |
| Key table | Config keys with owner (harness / Vinaya), default, trust rule. |
| Part header | Breadcrumb `1.2.2 · Executing`, parent link, child links. |
| Status badge | Built / Planned, on any section the docs mark as not built yet. |

## 5. The Vinaya process page and demo

Keep the current story (four kinds of work, four stages with Self-improvement as stage 4 run by the Improver). Add:

- A **Gates** section (`#gates`): three rings, 39 checks, "17 implement generic gates, 22 are Vinaya's own", link to `/docs/process/gates`.
- The "Built into the harness" line under stage 4, Log and Studio.

Demo fixes found against the Linear docs (data only, no design change):

| Where | Problem | Fix |
| --- | --- | --- |
| `process/fixtures/index.ts` (archive lines, 19 uses) | Close-out events are named `forge_write.written`. That family has no producer; close-out writes are `effect · verified`. | Use `effect.verified` with detail `op=archive · #<n>` |
| `process/fixtures/scripts.ts` | `review.decision` is not an event. | Use `dev_review_loop.round_ended` (the round outcome) |
| Complex work, stage 4 | The stats tiles show `6 of 6` green first round and `4` problems caught, while the report line says 52 tasks, 19 second rounds, 418 caught. | Use one set of numbers, e.g. `34 min`, `33 of 52` (52 tasks − 19 second rounds), `418` |
| Thinking steps | The six Issue checks and dispatch readiness never appear, though Thinking is where they run. | One terminal line in the Planner step: Issue checks passed for each written Issue |

## 6. Order of work

1. Finish the docs drafts (12 files still missing) — the docs content depends on them.
2. Navigation and redirects (Product menu order, Gates moved, Self-improvement added).
3. Demo data fixes (§5).
4. Docs pages, part by part, starting with Gates and Events (most detail, most value).
5. Product page template, then the five pages.
