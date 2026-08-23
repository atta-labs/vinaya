---
sidebar_title: Architect → Planner
title: Architect → Planner
order: 8
contract_id: architect-planner
description: Carries a product goal's declared tranche intents down to the Planner, so a tranche's goal is derived rather than invented.
status: active
producer: architect
consumer: planner
carrier: milestone-description
summary: Ever had a tranche's "why" live only in someone's head, one level above the plan?
---
# Contract: Architect → Planner

## The short version

This seam sits between declaring a product goal and planning the tranches that serve it. It exists because most tranches carry no Milestone at all — this contract governs the minority that do, and it is deliberately thin: one field crosses, matched by one key.

**What crosses** — the intent line for one tranche slug: `- <slug>: <intent text>`, written inside the Milestone's `### Tranche intents` section. Nothing else. The Architect does not name dependencies, sizing, traps, or an agent class — those remain entirely the Planner's, derived from reading the code, exactly as they are for an unmilestoned tranche.

**The hand-off is malformed when** — an intent line names a slug with no clear referent (the Architect should not invent a slug the Planner has not planned and will not plan), or when a tranche's Planner-authored rationale on its own Issues repeats or contradicts the intent line instead of leaving it alone. The intent is the *why-this-serves-the-larger-goal*; the rationale is the *why-this-task-is-shaped-this-way*. They answer different questions and neither substitutes for the other.

**What it does not carry** — sizing, dependency/conflict edges, traps, agent class, stop conditions, or documentation lists, all of which stay entirely the Planner's own to derive; any statement of status, which is derived from the forge and never written into a Milestone description by either role; and scheduling or estimates, which belong to whatever tool plans the roadmap.

**How it physically runs** — the carrier is the Milestone's own description. The Architect writes the intent line there, in the fixed `### Tranche intents` grammar, before or after the tranche it names is planned — order does not matter, because the tranche's goal is derived by matching the slug at read time, never by either role writing a pointer to the other. The Planner never edits the Milestone to consume this: reading the derived goal is automatic, the same way an unmilestoned tranche's empty goal is automatic.

---

## Reference

**Status:** active
**Seam:** the hand-off from the Architect (producer) to the Planner (consumer) — one direction, and thin by design, since most tranches never cross it at all.

---

## Why this file exists

A Milestone that names tranche intents is a claim about *why several tranches matter together* — a fact one altitude above any single tranche's own plan. Without a contract, that claim has no defined shape, and a Planner reading a Milestone's description free-form would either re-derive the product goal from scratch (duplicating the Architect's work) or invent detail the Architect never wrote (the same false-precision failure `contracts/planner-brief.md` guards against one seam down). This contract keeps the crossing to exactly one field, matched by exactly one key — a slug — so the two roles can never disagree about what crossed.

---

## The contract — field-by-field mapping

| Architect emits (Milestone field) | Planner consumes it as | What the consumption means |
|---|---|---|
| **`### Tranche intents` bullet** (`- <slug>: <intent text>`) | The tranche's derived **goal** (read via `intentGoalForSlug`, never stored) | The Planner does nothing to consume this — it is automatic, the same read path that gives an unmilestoned tranche its empty goal. The Planner never copies the intent text onto the Issue or into the rationale; the goal is derived at read time from the Milestone, always. |

That is the entire table. Compare `contracts/planner-brief.md`'s eight-field table — this seam is one field because the Architect's whole output is one field. Adding a second field to what the Architect emits is a Type 1 decision (`roles/architect.md`'s "one role, one job" constraint) and changes this contract, not a workaround inside it.

---

## Producer obligations (the Architect)

- Write an intent line for a slug only when the goal genuinely names that tranche — not speculatively, and not to reserve a name. An intent naming a slug the Planner never plans just sits there, `planned` forever, misleading a reader of the Milestone.
- Never write sizing, dependency edges, traps, agent class, or stop conditions into the Milestone. Those are entirely the Planner's, per `contracts/planner-brief.md`, whether or not this contract's seam is in play.
- Never write status. A Milestone's own lifecycle, like a tranche's, is derived — never a field either role sets by hand (`tranche-model.md` §4).

## Consumer obligations (the Planner)

- Read a tranche's derived goal (if any) at planning time as context, the same way an unmilestoned tranche's empty goal is context — never as a directive that changes sizing, boundary, or dependency edges. Those come from reading the code, always, per `roles/planner.md`'s mandatory deep-dig.
- Never edit a Milestone's description to add, correct, or remove an intent line. If an intent line is wrong or stale, that is escalated to whoever the Architect's output goes to next — not silently fixed mid-plan.
- Never treat an intent line as a substitute for the Planner's own rationale. The Issue still carries all eight `contracts/planner-brief.md` fields regardless of whether this Milestone-level seam is in play.

---

## Changing this contract

A contract changes **as a unit**, same discipline as `contracts/planner-brief.md`. A change to this file is a **Tier 1** change (the seam is thin enough that widening it does not by itself alter a cross-role authority boundary the way `planner-brief.md`'s eight fields do) — but it still changes what `roles/architect.md` may emit and what `roles/planner.md` may consume, so both role docs must still point here rather than restate the mapping.

---

*This contract is the seam. It is one row because the Architect's whole output, past the goal prose itself, is one row.*
