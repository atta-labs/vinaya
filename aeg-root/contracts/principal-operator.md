---
sidebar_title: Principal → Operator
title: Principal → Operator
order: 8.5
contract_id: principal-operator
description: Carries process authority down and content decisions up — the Principal tells the Operator which planned task to run, pause, or stop; the Operator brings the Principal the escalations only the Principal may rule.
status: active
producer: principal
consumer: operator
carrier: task-tool-grant, escalation-packet
summary: Ever handed someone the run button and then wondered who was supposed to make the call it stopped for?
---
# Contract: Principal → Operator

## The short version

This seam sits between the seat that decides **what is true and what is allowed** (the Principal) and the seat that **runs a selected task through the controller** (the Operator). It exists because the Operator has real process authority — start, pause, resume, cancel — and no content authority at all, so the two directions of the ask must be named or the Operator improvises the decisions it was never granted.

**What crosses, downward** — the Principal names which already-planned task the Operator should run, and may ask it to pause, resume, or cancel one. That is the whole of what the Principal delegates: process, over an already-dispatchable task. The Principal never asks the Operator to plan it, size it, edit its Issue, or change its criteria — none of those are the Operator's to do.

**What crosses, upward** — the Operator brings the Principal every escalation packet the controller addressed to the Principal: an escalation, a round cap reached, repeated findings with no progress, an unresolved confidence question, a reappeared finding. The Operator presents the packet as recorded and asks for a ruling, an approval, or a merge. It never supplies the decision itself.

**The hand-off is malformed when** — the Operator is asked to exercise content or ratification authority (rule, approve, publish a review, merge, edit an Issue, re-scope), or when a Principal-addressed escalation is cleared by the Operator rather than presented. Either way the boundary between process and content authority has been crossed, and the seam's whole purpose is to make that crossing visible and refused.

**What it does not carry** — a duration. The Principal may ask "what state is it in?"; the answer is derived and durationless. "When will it be done?" has no grounded answer on this seam, and the Operator supplies none.

**How it physically runs** — downward, the carrier is the Operator's tool grant: the five task tools plus the status-follow read, and nothing that could rule, approve, or merge. Upward, the carrier is the persisted escalation packet, whose `requestedAuthority` field names the Principal as the seat that must decide. Neither direction is a status write — the run's branch, pull request, and pause record are the status, read rather than restated.

---

## Reference

**Status:** active
**Seam:** the hand-off between the Principal (producer of process delegation and content rulings) and the Operator (consumer, running the selected task).
**Single source of truth for this seam.** `roles/principal.md` and `roles/operator.md` do not redefine what crosses here — they point to this file. AEG terms (seam, ratification, escalation, forge) are defined in the [glossary](glossary.md).

---

## Why this file exists

The Operator seat was, for a period, a set of tools with no role text: any session that found the task tools improvised the authority around them. The failure mode is specific — a seat with the run button and no instructions decides, on its own, the calls it was only ever meant to *stop for*. This contract names the two directions so the improvisation has nowhere to hide: what the Principal may delegate downward is bounded to process over an already-planned task, and what must come back upward is every decision the packet addresses to the Principal.

---

## The hand-off carrier

Two carriers, one per direction:

1. **Downward — the tool grant.** The Operator holds `task_start`, `task_status`, `task_escalation_read`, `task_resume`, `task_cancel`, and the status-follow read. The grant is the delegation: it is exactly the process authority the Principal hands down, and it contains no tool that could rule, approve, publish a review, merge, or edit an Issue. The router refuses any call outside it, so the delegation cannot silently widen.
2. **Upward — the escalation packet.** A paused run's persisted packet carries a `requestedAuthority` field. When it names the Principal, the Operator presents that packet — reason, inputs, held evidence, attempted recovery, and permitted next actions, verbatim — and waits for the Principal's ruling, approval, or merge.

---

## The contract — what each may ask of the other

| The Principal may ask the Operator to… | The Operator may ask the Principal to… |
|---|---|
| Run a specific already-planned, dispatchable task (`task_start`, or the `task run` composition) | Rule on an escalation the packet addresses to the Principal |
| Read a task's grounded status, or follow it (`task_status`, status-follow read) | Approve or merge — the ratification acts the Operator structurally cannot perform |
| Present a paused run's escalation packet (`task_escalation_read`) | Resolve a Principal-authority pause (round cap, no-progress, confidence, reappearance) with a decision, not a retry |
| Request continuation or cancellation of a run (`task_resume`, `task_cancel`) | Address a scope or criteria change to the Planner — the Principal redirects it there, as the Operator cannot edit the Issue |

**The Principal may NOT ask the Operator to** plan or size a task, edit its Issue or criteria, write code, approve or publish a review, merge, or state how long a run will take — the Operator has no grant for any of these, and asking does not create one.

**The Operator may NOT ask the Principal to** hand it a tool outside its grant, or to bless it ruling on a packet itself — the Operator presents; the Principal decides.

---

## Producer obligations (the Principal)

- Delegate only process authority over an **already-planned, dispatchable** task — never ask the Operator to bring a task into existence.
- Make the ruling, approval, or merge when an escalation packet is presented — the packet is a decision request, and the Operator cannot make it.
- Redirect a scope or criteria change to the Planner rather than asking the Operator to edit the Issue.

## Consumer obligations (the Operator)

- Confirm the task is already dispatchable before running it; refuse to plan it into readiness.
- Present every Principal-addressed escalation packet as recorded, `requestedAuthority` intact, and wait — never rule, approve, or merge to clear it.
- Keep every request inside the grant; when a task needs authority the grant lacks, name the seat that holds it rather than improvising past the refusal.
- Attach no duration to any status.

---

## Changing this contract

This file is the seam. Change it and both role docs' references as one unit; neither `roles/principal.md` nor `roles/operator.md` may redefine the boundary on its own.

*This contract is the seam. The Principal delegates the left column and decides the right; the Operator drains the left and raises the right. One source of truth, changed as a unit.*
