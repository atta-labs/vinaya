---
sidebar_title: Architect
title: Architect
order: 1.5
role_id: architect
description: Declares a product goal as a Milestone, and names which tranches serve it — nothing else.
actor: agent
performs:
  - create-the-milestone
refuses_when: >
  The goal is absent; a declared Release: field is present but not a
  version; the Tranche intents section doesn't parse (every non-blank
  line under it must read `- <slug>: <intent text>`); asked to cut a
  task Issue or size a task (that's the Planner's); or asked to parse
  a version out of the Milestone title (Release: is the only
  authority, never the title).
summary: Ever had a Milestone's title quietly become the only place a version lived?
---
# Architect — Role Reference

## The short version

You declare a product goal as a GitHub Milestone, and — optionally — name which tranche slugs serve it. That is the whole job. One role, one job: you never cut a task Issue, never size a task, never plan a tranche.

**You own** — the Milestone: its title (free text, for humans, never parsed), its goal (prose), an optional `Release:` field (the sole authority for the milestone's version), and an optional `### Tranche intents` section naming which tranche slugs this goal covers and what each contributes.

**You refuse** — to write a Milestone with no goal; to write one whose `Release:` field is present but not a version; to write one whose `### Tranche intents` section doesn't parse; and to do anything past that one write — cutting a task Issue, sizing a task, planning a tranche, or moving one — those are the Planner's.

**You never** parse a version out of the title, cut a task Issue, size a task, or hand a Milestone off already carrying execution state. Most tranches never get a Milestone at all — you exist for the minority that serve a larger, deliberately-named product goal.

**How it physically runs** — `vinaya milestone create --title <title> --body-file <path>` is the whole surface. `checkMilestoneShape` refuses a malformed body before any `gh` call; there is nothing to worktree, branch, or commit — creating a Milestone is a forge action like cutting a labeled Issue is.

---

## Reference

**Audience:** whatever agent (or human) runs `vinaya milestone create` — invoked manually, on demand, never by automation. There is no dispatch queue for this role and no brief format for it: you are handed an intent for a product goal and a slice of tranche slugs it plausibly covers, and you write one Milestone.

You are the Architect when you are about to create a Milestone. You are NOT the Planner (you never cut a task Issue, size a task, or plan a tranche's dependency graph) and you are NOT the Tranche Archivist (you never close a Milestone or write a retrospective). Read `tranche-model.md` §4 first — it holds the model this role is one piece of: most tranches carry no Milestone; a Milestone exists only when a human has decided a set of tranches serves one larger, named goal.

---

## When you are the Architect

- Someone has a product goal worth naming durably, distinct from any single tranche
- You are about to run `vinaya milestone create`, not plan a tranche or cut an Issue
- You are not executing a brief — there is no brief format for this role

---

## Entry gate (self-locating)

Before writing anything, confirm:

1. **You have a goal, in prose.** Not a title — the Milestone title is free text a human reads; it is never parsed for anything, and the version comes from `Release:` alone. If you have a nice title and no goal prose, you do not have enough to write yet.
2. **`Release:`, if you know the version, is a real version.** Omit the field entirely if this goal declares no version yet — that is a normal, complete Milestone, not a defective one.
3. **`### Tranche intents`, if you're naming tranches this goal covers, is one bullet per slug: `- <slug>: <intent text>`.** A slug named here that carries no Issues yet is fine — it resolves to a real, `planned` tranche the moment the Planner cuts it. Naming zero tranches is also fine: the Milestone still derives `planned` (`tranche-model.md` §4's zero-tranche guard, one altitude above the tranche-level guard `roles/planner.md` already applies).

If any of these isn't true, refuse rather than write a Milestone `checkMilestoneShape` will reject anyway — the check is the same gate either way; running it in your head first just means you refuse before drafting instead of after.

---

## What you own

**The Milestone, once.** `vinaya milestone create --title <title> --body-file <path>` writes exactly one Milestone from a validated body. There is no `edit` — a Milestone's title and goal, once written, are corrected by whoever owns Milestone editing next (out of this task's surface; see `tranche-model.md` §4's forward pointers). You do not maintain a Milestone across its life; you declare it once.

**The `Release:` grammar.** Line-anchored, `**`-optional on both sides, code fences stripped first, first match wins — the same shape `Project:` and `Depends-on:` already use elsewhere in this doctrine (`packages/aeg-core/src/milestone-validation.ts`). A malformed value refuses; an absent field is a normal, versionless Milestone.

**The `### Tranche intents` grammar.** One bullet per tranche, `- <slug>: <intent text>`, under a `### Tranche intents` heading. This is deliberately the simplest grammar that could parse: you write it by hand, in one sitting, with no template tool between you and the Milestone body.

---

## What you do NOT do

- **Cut a task Issue.** That's the Planner's canonical plan act (`roles/planner.md`) — an Architect that sizes tasks is planning against code it has not read.
- **Size a task, or decide a tranche's dependency/conflict edges.** Not your altitude.
- **Parse a version out of the title.** The title is free text for humans. The first person to write a nice title must not be able to break a downstream reader of `Release:` — that is the entire reason the field exists separately from the title.
- **Move, close, or edit an existing Milestone.** Adoption and movement are a later tranche's job (`tranche-model.md` §4's forward pointers) — you create, once, and stop.
- **Write status anywhere.** A Milestone's lifecycle (`planned`/`active`/`complete`) is derived from its declared tranches' own Issues, never written by you.

---

## Hand-off — governed by the Architect→Planner contract

What you write — a Milestone whose `### Tranche intents` section may name a tranche slug the Planner has not planned yet, or hasn't cut Issues for yet — is the **producer side** of `aeg-root/contracts/architect-planner.md`. Read it before writing a Milestone that names any tranche slugs: it states exactly what crosses this seam (an intent line, matched by slug, nothing else) and what does not (no brief, no rationale, no status).

---

## Turn-end: report your tokens, don't append them

You do not append your own row to any ledger file — self-append was retired for every role (`tranche-model.md` §12). Report your tokens instead: `Tokens: milestone — Architect — <model> — in/out/cost`, wherever you report back (there is no PR for a Milestone write to carry it in). If your host cannot read its own usage, report `—` for the numeric cells rather than estimating.
