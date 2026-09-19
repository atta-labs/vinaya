---
sidebar_title: Planner → Operator
title: Planner → Operator
order: 8.6
contract_id: planner-operator
description: The Operator runs what the Planner cut — the Planner makes a task dispatchable, the Operator operates it, and every scope or strategy change routes back to the Planner, never through the Operator.
status: active
producer: planner
consumer: operator
carrier: dispatchable-issue, escalation-redirect
summary: Ever let the seat that runs the work quietly become the seat that re-scopes it?
---
# Contract: Planner → Operator

## The short version

This seam sits between the seat that **decides what a task is** (the Planner, across its plan and dispatch acts) and the seat that **runs it** (the Operator). It exists because running a task and re-scoping one look adjacent from the run button, and they are not: the Operator operates what the Planner already made ready, and the moment the work needs its scope, criteria, or approach changed, that is the Planner's again — never the Operator's to edit in flight.

**What crosses, downward** — a task the Planner has made dispatchable: its Issue cut, its dependencies merged, no conflicting sibling open, its brief renderable. The Planner's dispatch act is what turns a planned Issue into a startable run; the Operator picks it up from there and operates it through the controller.

**What crosses, upward** — a scope or strategy question. When a run reveals that the plan is wrong, the boundary is wrong, or the approach must change, the Operator does not edit the Issue or improvise a new plan. It routes the question back to the Planner (`severity: strategy` for approach, `severity: execution` for a missing detail), and waits for a re-plan or a redispatch.

**The hand-off is malformed when** — the Operator is handed a task that is *not* dispatchable (no Issue, an unmerged dependency, an open conflicting sibling) and asked to run it anyway, or when the Operator edits the plan, the Issue, or the criteria instead of routing the change back. Either way the run seat has taken on planning authority it does not hold.

**What it does not carry** — the power to move a task between tranches, re-size it, or rewrite its criteria. Those are scoping decisions, and they belong to planning. The Operator surfaces the need; the Planner exercises the authority.

**How it physically runs** — downward, the carrier is the dispatchable Issue itself, made ready by the Planner's dispatch act and confirmed at the Operator's own entry gate. Upward, the carrier is an escalation whose severity routes it to the Planner. Starting the run is a controller call against an already-ready task, not a status write.

---

## Reference

**Status:** active
**Seam:** the hand-off between the Planner (producer of dispatchable tasks and re-plans) and the Operator (consumer, running them).
**Single source of truth for this seam.** `roles/planner/reference.md`'s delegation section and `roles/operator.md` point to this file; neither redefines the boundary alone. AEG terms (seam, tranche, brief, dispatch, gate) are defined in the [glossary](../glossary.md).

---

## Why this file exists

The Operator holds the run button, and from there re-scoping a task feels like part of running it. It is not. If the Operator could edit an Issue's criteria or reshape its plan mid-run, the plan would stop being a durable, reviewed decision and become whatever the run seat found convenient — the exact drift the plan/execute split exists to prevent. This contract draws the line: the Planner makes a task ready and owns every change to what it is; the Operator runs what it was handed and routes every scope change back.

---

## The hand-off carrier

Two carriers, one per direction:

1. **Downward — the dispatchable Issue.** The Planner's dispatch act confirms the task's gates (Issue exists, dependencies merged, no open conflicting sibling, render complete) and makes the run startable. The Operator confirms the same gates at its own entry gate before starting — the readiness is a fact to verify, never an assumption to make.
2. **Upward — the severity-routed escalation.** A scope or approach change the run reveals is raised as an escalation the Planner receives, not an edit the Operator performs.

---

## The contract — what each may ask of the other

| The Planner may ask the Operator to… | The Operator may ask the Planner to… |
|---|---|
| Run a task the dispatch act has made dispatchable | Re-plan or re-scope a task whose plan a run proved wrong (`severity: strategy`) |
| Operate the run it cut — start, follow status, present escalations, request continuation or cancellation | Supply a missing execution detail the brief did not anticipate (`severity: execution`) |
| Stop or cancel a run the plan has superseded | Cut or make dispatchable a task that is not yet ready, rather than running a task that is not |
| — (the Planner never asks the Operator to author the plan) | Edit the Issue or its criteria on the Operator's behalf — the Operator never edits it directly |

**The Planner may NOT ask the Operator to** author or amend a plan, write the brief, or make a task dispatchable — cutting the Issue and rendering the brief are the Planner's own acts.

**The Operator may NOT ask the Planner to** bless it editing the Issue itself — the Operator surfaces the change; the Planner makes it.

---

## Producer obligations (the Planner)

- Hand the Operator only a **dispatchable** task — Issue cut, dependencies merged, no open conflicting sibling, brief renderable. Name the Operator as the seat that runs what the dispatch act cut (see `roles/planner/reference.md`'s delegation section).
- Receive a scope or strategy escalation and re-plan or redispatch, rather than expecting the Operator to work around a wrong plan.

## Consumer obligations (the Operator)

- Confirm dispatch readiness at the entry gate before starting; refuse to run a task that is not yet ready.
- Route every scope, criteria, or approach change back to the Planner as an escalation — never edit the Issue or the plan directly.
- Operate the run the Planner cut; do not author a parallel plan, re-size the task, or move it between tranches.

---

## Changing this contract

This file is the seam. Change it and both role docs' references as one unit; `roles/planner/reference.md`'s delegation section and `roles/operator.md` point here rather than each restating the boundary.

*This contract is the seam. The Planner fills the left column with dispatchable work; the Operator drains it and raises scope changes on the right. One source of truth, changed as a unit.*
