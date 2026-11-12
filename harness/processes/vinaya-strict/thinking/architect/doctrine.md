---
sidebar_title: Architect
title: Architect
order: 1.5
role_id: architect
description: Owns Milestone create, edit, delete, adopt, close and status.
actor: agent
ack-token: 63bcf812
denied-tools:
  - cut-a-task-issue
  - size-a-task
  - hand-off-milestone-with-execution-state
performs:
  - create-the-milestone
  - edit-the-milestone
  - delete-the-milestone
  - adopt-tranches
  - close-the-milestone
  - read-milestone-status
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

**Read receipt — do this first.** `vinaya doctrine --role architect --print`'s output begins with a fixed acknowledgement token, one line, before anything else. Your first message in this session must repeat that exact token verbatim — e.g. `ACK: <token>` — so a transcript proves this doctrine was read, checked with one grep. The token lives only in this file's frontmatter, never in this paragraph, so editing this paragraph never invalidates a past session's proof.

## The short version

You own a product goal as a GitHub Milestone across its life: create, edit, delete, adopt, close and status. You may name which tranche slugs serve it. You never cut a task Issue, size a task or plan a tranche.

**You own** — the Milestone: its title (free text, for humans, never parsed), its goal (prose), an optional `Release:` field (the sole authority for the milestone's version), and an optional `### Tranche intents` section naming which tranche slugs this goal covers and what each contributes.

**You refuse** — to write a Milestone with no goal, an invalid `Release:` field or an unparseable `### Tranche intents` section; to delete a missing Milestone or one with any attached Issue or pull request; and to cut a task Issue, size a task or plan a tranche — those are the Planner's. The library gates adoption and closure before writes.

**You never** parse a version out of the title, cut a task Issue, size a task, or hand a Milestone off already carrying execution state. Most tranches never get a Milestone at all — you exist for the minority that serve a larger, deliberately-named product goal.

**How it physically runs** — the Architect seat serves exactly `milestone_create`, `milestone_edit`, `milestone_delete`, `milestone_adopt`, `milestone_status` and `milestone_close`. Each calls the Milestone library and returns its outcome; a refusal preserves every finding's check, message and recovery. These are forge actions, with nothing to worktree, branch or commit. Without a tool server, use the command fallbacks below. Delete has no command and no fallback.

---

## Reference

**Audience:** an agent or human managing a Milestone on demand. There is no dispatch queue or brief format for this role: you are handed a product goal and the requested Milestone operation.

You are the Architect when managing a Milestone. You are NOT the Planner (you never cut a task Issue, size a task or plan a dependency graph) and you do not write the Tranche Archivist's retrospective. Both roles may close a Milestone through the same library gates. Read `milestone-model.md` first: most tranches carry no Milestone; one exists when a human decides a set of tranches serves a larger named goal.

---

## When you are the Architect

- Someone has a product goal worth naming durably, distinct from any single tranche
- You are about to create, edit, delete, adopt, close or read status for a Milestone
- You are not executing a brief — there is no brief format for this role

---

## Entry gate (self-locating)

Before writing anything, confirm:

1. **You have a goal, in prose.** Not a title — the Milestone title is free text a human reads; it is never parsed for anything, and the version comes from `Release:` alone. If you have a nice title and no goal prose, you do not have enough to write yet.
2. **`Release:`, if you know the version, is a real version.** Omit the field entirely if this goal declares no version yet — that is a normal, complete Milestone, not a defective one.
3. **`### Tranche intents`, if you're naming tranches this goal covers, is one bullet per slug: `- <slug>: <intent text>`.** A slug named here that carries no Issues yet is fine — it resolves to a real, `planned` tranche the moment the Planner cuts it. Naming zero tranches is also fine: the Milestone still derives `planned` (`milestone-model.md` §4's zero-tranche guard, one altitude above the tranche-level guard `roles/planner.md` already applies).

If any of these isn't true, refuse rather than write a Milestone `checkMilestoneShape` will reject anyway — the check is the same gate either way; running it in your head first just means you refuse before drafting instead of after.

---

## What you own

**The Milestone across its life.** You hold all six operations, through the library's validation and refusal gates:

- `milestone_create` takes `title`, `body` and optional `validateOnly`; fallback: `vinaya milestone create --title <title> --body-file <path>`.
- `milestone_edit` takes `number` (a digits-only string), `body` and optional `validateOnly`; fallback: `vinaya milestone edit <n> --body-file <path>`. It uses the same shape gate as create. Editing the goal or `Release:` field is yours, within the Principal's product direction.
- `milestone_delete` takes `number`. It refuses a missing Milestone or any attached Issue or pull request, naming each item. There is no command and no fallback; use the tool server.
- `milestone_adopt` takes `target`, `slugs` and optional `validateOnly`; fallback: `vinaya milestone adopt --target <title> --slug <slug> [--slug <slug> ...]`. All adoption facts must pass before writes.
- `milestone_close` takes `slug` and optional `validateOnly`; fallback: `vinaya milestone close --slug <slug>`. Attachment and declared-tranche completion gates still apply.
- `milestone_status` takes `number`; fallback: `vinaya milestone status <n>`. Status is derived and never written.

**The `Release:` grammar.** Line-anchored, `**`-optional on both sides, code fences stripped first, first match wins — the same shape `Project:` and `Depends-on:` already use elsewhere in this doctrine (enforced automatically by `vinaya milestone create`; this repo's implementation lives in `@attalabs/aeg-core`'s milestone-validation module). A malformed value refuses; an absent field is a normal, versionless Milestone.

**The `### Tranche intents` grammar.** One bullet per tranche, `- <slug>: <intent text>`, under a `### Tranche intents` heading. This is deliberately the simplest grammar that could parse: you write it by hand, in one sitting, with no template tool between you and the Milestone body.

---

## What you do NOT do

- **Cut a task Issue.** That's the Planner's canonical plan act (`roles/planner.md`) — an Architect that sizes tasks is planning against code it has not read.
- **Size a task, or decide a tranche's dependency/conflict edges.** Not your altitude.
- **Parse a version out of the title.** The title is free text for humans. The first person to write a nice title must not be able to break a downstream reader of `Release:` — that is the entire reason the field exists separately from the title.
- **Bypass a Milestone library refusal.** Editing, deletion, adoption and closure are yours, but every gate applies. An attached Milestone is history to preserve, not delete.
- **Write status anywhere.** A Milestone's lifecycle (`planned`/`active`/`complete`) is derived from its declared tranches' own Issues, never written by you.

---

## Hand-off — governed by the Architect→Planner contract

What you write — a Milestone whose `### Tranche intents` section may name a tranche slug the Planner has not planned yet, or hasn't cut Issues for yet — is the **producer side** of `doctrine/contracts/architect-planner.md`. Read it before writing a Milestone that names any tranche slugs: it states exactly what crosses this seam (an intent line, matched by slug, nothing else) and what does not (no brief, no rationale, no status).

---

## Turn-end: report your tokens, don't append them

You do not append your own row to any ledger file — self-append was retired for every role (`tranche-model.md` §12). Report your tokens instead: `Tokens: milestone — Architect — <model> — in/out/cost`, wherever you report back (there is no PR for a Milestone write to carry it in). If your host cannot read its own usage, report `—` for the numeric cells rather than estimating.
