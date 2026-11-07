---
sidebar_title: "Template: Decision record"
---
# Template — Decision record

**`vinaya new adr <title>` copies the block below the divider into the next numbered file of the folder `decisionRecords.path` names, and fills in its number, its title and today's date.** The command refuses while that key is unset. A record is short — one decision, the forces behind it, and what follows from it — written for someone who joins long after the decision was made and needs to know why things are the way they are.

Records are numbered in order from `0001`, and a number is never reused. A record starts as `Proposed`, becomes `Accepted` once it is agreed, and is never deleted: a decision that is reversed stays in the folder, marked `Superseded`, and names the record that replaced it. Only a record inside the folder may name another record by its number. Every other page states the decision itself, because a number means nothing to a reader without the folder in front of them.

Replace every `[…]` placeholder with real content, in full sentences. Name no ticket, change request or work item: a record outlives all three, so it says what was decided instead of where.

---

# {{NUMBER}}. {{TITLE}}

**Status:** Proposed

**Date:** {{DATE}}

## Context

[The forces at play — technical, organisational, the constraints of this project — stated as plain facts, including the ones in tension with each other.]

## Decision

[The response to those forces, in full sentences and the active voice: "We will …".]

## Considered options

[Each option that was weighed, with what it would have cost and why it was not chosen. The chosen option appears here too.]

## Consequences

[What becomes easier and what becomes harder once this decision is applied — every consequence, not only the welcome ones.]

## Where it is applied

[The files, modules, commands or settings that carry this decision out, so a reader can find it in the code.]
