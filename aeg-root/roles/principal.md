---
sidebar_title: Principal
title: Principal
order: 8
role_id: principal
description: The person accountable for what merges — the one seat holding authority the mechanism never grants an agent.
actor: human
performs:
  - decide-strategy-and-roadmap
  - make-final-architecture-decisions
  - merge-the-pull-request
  - reject-a-direction
  - ratify-type1-decisions
  - dispatch-tasks
  - review-pull-requests
refuses_when: >
  No self-refusal gate — this doc describes the Principal's seat from the
  perspective of agents interacting with it. The corresponding constraint is
  on those agents: they must not write code, author briefs, plan tranches,
  execute tasks, merge PRs, or close Issues out of band on the Principal's
  behalf.
summary: Who's actually accountable for what merges?
---
# Principal — Role Reference

## The short version

You are the one seat in the harness a mechanism cannot fill: a person, accountable for what merges. Every agent here runs on authority delegated from this seat, and some of that authority is never delegated at all.

**You own** — strategy and the roadmap: which work happens, in what order, at what scope. The final call on any decision that closes a design branch permanently — an agent may propose, pressure-test and recommend, but deciding is yours. The merge, which no agent performs even where it holds the access. Ratification: a decision waiting on your word stays pending until you give it, and never promotes itself by waiting. And the rhythm — you are absent while a task executes, and re-engage to review, to ratify, and when something escalates into a product question.

**You refuse** — a direction, at any point in its life: an idea, a plan, a brief, an open pull request, or something already merged. A merge, when what is in front of you is not ready. A ratification, which is refused by not being granted. The harness takes all three without pushback: an agent may state a concern once, concretely, but it may not overrule you, and it may not manufacture your agreement by proceeding.

**You never** write the code, author the briefs, decompose the tranches, execute the tasks, or keep the day-to-day records current — each has a role that does. The boundary binds the other way too: no agent may merge on your behalf, close a task's issue out of band, treat an unratified decision as final because you were absent, or widen the scope it was given. An agent that is unsure asks.

**How it physically runs** — you work through the forge and through conversation, not through a tool this harness owns. You dispatch a task by handing its brief to a coding agent, and read the work as pull requests. The merge completes it: it closes the task's issue and, being a fact on the forge, is itself the record that the work is done. Nothing records status for you to read — the branches, the pull requests and the merges are the status. Work waiting on you is marked on the forge, so a review window is a list you open rather than a memory you keep.


---

## Reference

**Audience:** AI agents (Planner, Developer) interacting WITH the Principal. Not the Principal themself. This document tells agents what lives in the Principal's seat so they don't try to do the Principal's job.

---

## What the Principal owns

The Principal holds final authority over:

- **Strategy and roadmap.** Which projects get built, in what order, at what scope. The roadmap lives outside AEG (the company's tool, or — for solo work — the per-project backlogs); the Principal owns it. No agent makes these calls autonomously.
- **Final architecture calls.** Type 1 (irreversible) decisions. An agent can propose, pressure-test, and present a recommendation. The Principal decides. See `state-machine.md` Section 6 for the Type 1 / Type 2 distinction.
- **The merge button.** No agent merges PRs to main without Principal approval, even when forge write access is available. Merge authority is Principal-only unless the brief's `principal_delegate:` field explicitly delegates it for a specific PR.
- **Right to reject.** The Principal can reject a direction at any phase — idea, brief, PR, or post-merge — and the system accepts that without pushback. Agents can surface concerns but not override.
- **Ratification.** Type 1 decisions are not ratified until the Principal explicitly says so. PENDING decisions wait; they do not auto-promote.
- **Editing an already-declared Milestone.** `vinaya milestone edit <n> --body-file <path>` corrects a Milestone's goal or `Release:` field after the Architect's one-time write — the same product call declaring it was (`milestone-model.md` §5), never the Architect's or Planner's (`roles/architect.md` "What you do NOT do").
- **Changing a task's scope mid-flight.** `vinaya issue objectives edit <n> --add "<sentence>" | --drop O<k> | --replace O<k> "<sentence>" --reason "<text>"` rewrites the task Issue's `## Objectives` section through the validated forge-write path and posts one versioned, findable comment recording the previous list, the new list, and the reason. This voids the standing review verdict on that task's open PR — `vinaya review status` names it `objectives moved — re-review required` (once the sibling task wiring that reason lands). If a `dev-review-loop` is running that task, it reads objectives from this same versioned edit comment (never the live Issue body), so its next round picks up the change automatically; if the edit lands between a round's reviewer dispatch and its verdicts coming back, the loop discards that round's verdicts unheld and unpublished and pauses with reason `objectives_changed`, naming the superseded version, the new version, and this exact edit invocation — resume it the same way as any other pause, with `vinaya dev-review-loop --resume <pr>`.
- **Ruling on a contested finding.** `vinaya pr rule <pr> --file <ruling.md>` posts the Principal's decision as its own marked, versioned PR comment — never mistaken for a code-review or security verdict, since it refuses a file carrying verdict grammar. A ruling posted after a clean verdict already exists voids it (`review-validity-v1` task 3, O2): every rendered verdict carries the newest ruling ordinal it was judged against on a `Ruling ordinal:` line, and the merge gate compares that ordinal to the PR's actual newest ruling — a mismatch reads as unbound, the same fail-closed shape `objectives moved — re-review required` already uses, until reviewers re-cast against the new ruling. If a `dev-review-loop` is running that task and a ruling lands between a round's reviewer dispatch and its verdicts coming back, the loop discards that round's verdicts unheld and unpublished and pauses with reason `ruling_posted`, naming the superseded ordinal, the new ordinal, and the ruling's own marker identifier — resume it the same way as any other pause, with `vinaya dev-review-loop --resume <pr>`.

---

## What the Principal does NOT do

- **Write code.** The Developer does this.
- **Author briefs.** No one does, by hand — the Planner's dispatch act renders the brief mechanically from the task Issue's own sections at dispatch time. The Principal approves the underlying rationale (at plan time) and the tranche, but does not draft brief prose.
- **Plan tranches.** The Planner does this. The Principal approves the tranche but does not decompose it.
- **Execute tasks.** The Developer executes. The Principal dispatches (by hand, or via an automation layer) but does not do the work.
- **Manage day-to-day PM docs.** The Planner maintains the tranche files and `thinking.md` during working sessions. The Principal approves and merges. (`state.md`, `now.md`, and the per-project pinned state Issue are all retired — active-work state is derived from the forge; a non-derivable operational fact is an ordinary open Issue, closed when resolved.)
- **Monitor every blocked task.** The Planner watches `vinaya/needs:execution-input` and `vinaya/needs:strategy-input`. The Principal monitors `vinaya/needs:principal-input` only.

---

## How the Principal works

In a typical working period:

1. Opens a chat/planning surface. Talks to the Planner.
2. That role reports status, surfaces decisions that need the Principal's call.
3. Principal makes decisions, approves the tranche and its task rationales, asks for spec review.
4. Principal dispatches tasks — by hand (running the Planner's dispatch act, which renders and posts the brief and pastes it into the coding agent) or via an automation layer if one is connected.
5. At ratification windows: reads the `vinaya/needs:principal-input`-labeled Issues/PRs, resolves pending items.
6. Reviews PRs on the forge. Code review for correctness and scope compliance.
7. Merges PRs after Planner spec review and CI passes. (The merge auto-closes the linked Issue and is itself the `merged` status — derived, not written.)

`vinaya task status` answers "what's running right now" across every dispatched task in one glance — each open task Issue with a frozen brief, its pull request, and whether its loop is `running` (with the driver pid), `paused` (with the reason), `published`, or has `no driver` — read from the outbox and the forge, never from a terminal-by-terminal `ps` scan.

The Principal does not need to be present during task execution. Dispatch and escalation routing are handled by the Planner (and an automation layer, if used); the Developer executes. The Principal re-engages at windows, at PR review time, and when escalations reach `severity: product`.

---

## The review loop, by hand

Until a coordinator program exists, the Principal is the loop's coordinator, per PR:

- **Track the id set.** Each PR's finding ids (`F1`, `F2`, …) and current states live in the verdict comments on the forge, never in a file — read them fresh each round.
- **Apply the three triggers.** Pause when a resolved id reappears, when two consecutive rounds resolve no prior id, or when one id stays `open` three consecutive rounds while others resolve. Round five is a backstop, not a trigger.
- **Pause with the label.** Apply `vinaya/needs:principal-input`; never invent a new label or status field.
- **Work the stall menu, cheapest first.** A different role in the seat, resume with the trigger overridden, reseed the Developer, abandon.
- **Give the go on surfaced findings.** A finding outside round two's delta, any non-blocking severity, waits on this decision rather than driving the verdict.
- **Rule with `vinaya pr rule`, never a raw PR comment.** A ruling on a contested finding posted this way carries the `<!-- aeg:principal:ruling:<pr>-<k> -->` marker and a version, so it is findable on the forge and never confused with a code-review or security verdict comment.

A coordinator program replaces this by-hand duty when one exists.

**Recovering the automated loop.** `vinaya dev-review-loop --task <n>` is that coordinator. If it crashes, or a poll (waiting for the PR to appear, or for the branch head to change after a gate-red dispatch) times out, the recovery is simply re-running the same command against the same task. Round `1`'s own entry checks the forge first: an already-open pull request on the developer's branch means it attaches — no developer is started — and a remote branch with no open pull request yet resumes the recorded developer session once, instructed to open it. Either way, a re-run never starts a second developer.

---

## Communication style with the Principal

These rules apply to any agent talking to the Principal — on any chat or coding-agent surface, in any context. *(The specifics below are this repo's house style; a different team sets its own.)*

- **Terse. No preamble.** Skip "Great question" and "I'd be happy to help." Start with the answer or the decision.
- **No time-of-day, energy, or wellness framing.** Do not open with "Good morning" or "Hope you're doing well."
- **Direct recommendations, not balanced presentations.** If one option is clearly better, say so. "Option A is correct because X. Option B has problem Y." Not "Both have tradeoffs."
- **Don't repeat back what the Principal just said.** Start from the next relevant thing.
- **Push back when warranted.** If a direction is wrong, architecturally risky, or contradicts a prior decision, say so concretely. Don't manufacture agreement to avoid friction.
- **Diagnose before iterating.** Identify the root cause before proposing a fix. "The issue is X because Y; the fix is Z" beats "Let me try A, then B, then C."
- **Match length to substance.** Don't pad.
- **Project files are authoritative.** When memory conflicts with current repo state, trust the file. Say "I see in the spec that..." not "I recall that..."

---

## What you do NOT do as an agent talking to the Principal

- **You do not act AS the Principal.** You are not the Principal. You do not have their authority.
- **You do not make final calls in their absence.** You can make Type 2 decisions in their absence (Planner) or execute briefs (Developer). You do not make Type 1 decisions and call them final without ratification.
- **You do not merge PRs** even if forge write access is available to you. The merge button is the Principal's.
- **You do not close task Issues out of band** without their direction — an Issue closes when its PR merges (`Closes #N`). Closing it manually desyncs the task's derived status from reality.
- **You do not expand scope on their behalf.** "While I'm in there, I should also..." is scope creep. Stop and ask.
