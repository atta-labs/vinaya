---
sidebar_title: The Milestone Model
section: Overview
---
# Milestones — the altitude above the tranche

**Status:** draft
**Supersedes:** the milestone description previously embedded in `tranche-model.md` §4 — moved here so the concept has one home instead of living as a blockquote inside the tranche's own file.

A **Milestone** is a product goal, and it is the one altitude above the tranche. This is new: earlier AEG had no concept above the tranche at all (`tranche-model.md` originally called the tranche "the top of AEG" — that was true until this layer shipped, `0.19.0`). Most tranches still carry no Milestone and need none; a Milestone exists only when someone deliberately declares a goal that one or more tranches serve.

For where this sits relative to the other two altitudes, see `tranche-model.md` (one below) and `task-model.md` (two below).

---

## 1. What a Milestone is, and is not

A Milestone is a real GitHub Milestone object. Its **title is free text**, read by no parser — a product goal, not an identifier. Its description carries three things:

- **The goal** — prose, whatever is left once the two fields below are removed. Mandatory.
- **An optional `Release:` field** — the sole authority for the Milestone's target version. Never the title: the first person to write a nice title must not be able to break a downstream reader that expected a version there.
- **An optional `### Tranche intents` section** — one `- <slug>: <intent text>` bullet per tranche this Milestone's goal covers, written before those tranches necessarily have any Issues cut yet.

A Milestone is **not** a tranche, and is not required for a tranche to exist. A tranche's identity is its `vinaya/tranche:<slug>` label — never a Milestone. The exception is the legacy case: a Milestone titled exactly a tranche's slug still means that one tranche, forever, for every Milestone created before this layer existed. Every Milestone created since is a real many-tranches container, not a slug-matching accident.

**A tranche's goal is derived, never stored:** it is the intent line matching that tranche's slug, found by searching every Milestone's description — not a field anyone writes onto the tranche itself. A slug with no matching intent line anywhere resolves to an empty goal, same as a tranche with no Milestone at all; an intent line naming a slug that carries no Issues yet is a real, `planned` tranche, not a missing one (`intentGoalForSlug`/`goalFromMilestones`, `@attalabs/aeg-forge-state`).

---

## 2. Truth domains — the same rule as the tranche, one altitude up

| Domain | Holds | Mutable by |
|--------|-------|-----------|
| **The Milestone object** | The goal, the optional `Release:` field, the optional `Tranche intents` section | Architect (at declaration time) |
| **The Git forge** (which tranches carry which labels, which Issues those labels reach) | All live lifecycle state — derived, never stored | the act of working, same as every altitude below it |

A Milestone stores no status. Its lifecycle (§4) is computed from its tranches, exactly as a tranche's lifecycle is computed from its tasks. Nothing here duplicates the tranche's own state — a Milestone reader asks "what are this Milestone's tranches, and what do they derive to," never "let me re-derive the tasks myself."

---

## 3. The Architect — the one role that creates a Milestone

The **Architect** (`roles/architect.md`) is the only role that creates a Milestone, via `vinaya milestone create --title <title> --body-file <path>`. The Planner does not create Milestones — a tranche it plans needs no Milestone at all, and most don't (`tranche-model.md` §6). `checkMilestoneShape` refuses a malformed body — missing goal, a `Release:` field present but not a version, an unparseable `Tranche intents` section — before any write reaches the forge, the same discipline `checkIssueRationale` applies to a task Issue.

Moving an **existing** tranche into a Milestone is a separate act: `vinaya milestone adopt --target <title> --slug <slug> [--slug <slug> ...]`, never done by hand. It reattaches every Issue carrying each named tranche label to the target Milestone's native `milestone` field (GitHub-view hygiene — no reader in this model consults that field, only the label — the same reason `vinaya issue create` auto-attaches a brand-new task Issue to its tranche's open Milestone at creation time, resolving `resolveMilestoneAttachTarget`'s legacy-title-or-intent-declared match to the Milestone's own title before handing it to `gh`), then closes (never deletes) each slug's old legacy tranche-Milestone. `checkAdoptable` gathers every fact for every named slug and refuses the whole invocation before any write — an unknown slug, a slug whose label carries no Issues, a target that doesn't exist or is closed, a slug already adopted elsewhere — so one bad slug blocks the whole call, never a partial move.

Correcting an already-written Milestone's goal or `Release:` field — `vinaya milestone edit <n> --body-file <path>`, gated by the same `checkMilestoneShape` check `create` uses — belongs to neither role above. Revising a stated goal is the same product call declaring it was (§5, stage 1: "the goal and its scope are a product call, not a derivable fact"), so it is the Principal's (`roles/principal.md` "What the Principal owns"), never the Architect's (its one write is create-once, `roles/architect.md` "What you own") and never the Planner's (its altitude is tranche shape, not Milestone-body grammar).

---

## 4. The lifecycle: `planned → active → complete`

The same three states a tranche derives (`tranche-model.md` §11, one altitude down), computed one altitude up: from a Milestone's **tranches**, not from Issues directly.

- **planned** — every tranche this Milestone names is itself `planned`, or the Milestone names no tranches yet. Nothing under this goal has started.
- **active** — at least one of this Milestone's tranches is `active`. The goal is in flight.
- **complete** — every tranche this Milestone names has derived `complete`. Same at-least-one guard the tranche/task levels use: a Milestone naming zero tranches never reads `complete`, only `planned`.

Nobody sets this by hand and nothing writes it back to the Milestone object — it's asked of the forge the same way every other altitude is.

`vinaya milestone status <n>` is that ask, made concrete: for every `- <slug>: …` line in a Milestone's `### Tranche intents` section, it prints the slug, its derived lifecycle, and its labeled Issues' counts (`merged`/`open`/`not planned`) — read-only, nothing written. A slug with an intent line and zero labeled Issues yet prints `planned` with `0 issues`, per §1: a real, not-yet-started tranche, never an error.

### The trap this level actually has: a closed legacy Milestone with real work still under it

`vinaya milestone adopt` closes the old one-tranche Milestone it retires — closed, never deleted, so the provenance survives. The closed Milestone still legacy-title-matches its slug forever (§1's exception). Found live, `0.19.1`: a reader that trusts a closed legacy Milestone's own `state` unconditionally reports the tranche `complete` even when its real, still-open Issues have already moved to a new Milestone via `adopt` — the tranche's true lifecycle lives in the label population, not in the Milestone object `adopt` walked away from. The fix: when a legacy-matched Milestone is closed AND its slug's labeled Issues are non-empty, derive from those Issues, not from the closed Milestone's `state`. An empty label population under a closed legacy Milestone still means what it always meant — a genuinely historical tranche, or one nobody has adopted away from yet.

---

## 5. Flow stages — what actually happens, in order

This is the operational sequence, not the derived-status vocabulary above (§4 is what Studio *reads* to display progress; this section is what actually *happens*, and who does it). Today every stage below is a human or a thin dispatch script deciding to start the next one, based on prose an agent reads. Nothing about the sequence changes once the Atta Engine can run it as a compiled flow (`Migrate the vinaya flow onto the Atta Engine`, milestone tracking that work) — the stages are the same either way; only the mechanism driving the transitions changes.

1. **Plan** — the Architect declares the goal (`vinaya milestone create`) and names which tranches serve it, either up front (a `Tranche intents` bullet per tranche, before any of them have Issues yet) or by adopting tranches that already exist. This is the only stage a human decision genuinely gates: the goal and its scope are a product call, not a derivable fact.
2. **[named tranches run their own flow]** — each tranche this Milestone names runs the full Tranche flow (`tranche-model.md` §11 "Flow stages") independently: Plan → Dispatch → Archive. The Milestone object itself does not orchestrate this — it is a passive container whose lifecycle (§4) is computed from what its tranches do — but something still has to decide *when* each named tranche actually starts. Today that's the Principal or a thin dispatch script, the same actor `tranche-model.md`'s own architecture note names for every altitude. Once the Atta Engine automates this, that actor is the engine's own scheduler (dependency-aware start-what's-ready/park-what's-blocked composition, tracked under `Migrate the vinaya flow onto the Atta Engine`) — not a new conversational role, the engine's internal machinery.
3. **Close** — once every tranche this Milestone names has archived, the Milestone derives `complete` on its own; nothing writes a close action to the Milestone object. If the Milestone carried a `Release:` field, that's the version this goal was targeting — cutting the actual release (tag, changelog, publish) is a separate, still largely manual act today (`aeg-root/state-machine.md` has no Milestone-release automation yet).

---

For the tranche altitude below this one, see `tranche-model.md`. For the task altitude below that, see `task-model.md`. For the full derivation rule chain behind §4, see [`/docs/state-machine`](https://vinaya.attalabs.dev/docs/state-machine) — this file keeps the rules, that page carries the machine, same discipline `tranche-model.md` §3 already applies one altitude down.
