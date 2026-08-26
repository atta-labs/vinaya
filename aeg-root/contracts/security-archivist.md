---
sidebar_title: Security → Archivist
title: Security → Archivist
order: 7
contract_id: security-archivist
description: Carries the security review's verdict and findings into the permanent record, so a recorded pass is a copied fact, not a claim.
status: active
producer: security
consumer: archivist
carrier: pr-verdict-comment
summary: Ever seen a record claim a security pass with nothing behind it?
---
# Contract: Security Reviewer → per-task Archivist

## The short version

This seam sits between the security pass and the permanent record of the work it examined. It exists because the record's `Security:` field can only be honest if it is copied from a verdict that says what was actually checked.

**What crosses** — the Security Reviewer's verdict, and the merged pull request that carries it. The verdict itself: pass, or fail. The findings, each with a severity, so the record can tell a hardening note from an exploitable surface. The explicit result of each scan — the configuration scan's outcome, and whether any secret was found. And the reviewer's one-line token report, the ledger's only source for this role's turn.

**The hand-off is malformed when** — the verdict line is absent, decorated, or unclear; when a finding carries no severity; when a scan result is simply not stated; or when a re-pass edits the earlier verdict instead of posting a new one. A verdict comment in any of these states is not posted; the reviewer revises it first. "Looks fine security-wise" is the failure this seam was written against: it leaves close-out the choice of inventing a field or leaving a hole.

**What it does not carry** — permission to close out an unmerged change: the verdict is not the authorisation, the merge is. Nor a second security opinion at close-out: the record copies the verdict, it never re-judges it. Nor the content of any secret found: the verdict comment freezes into the permanent record at merge, so a finding names where a secret lives and enough characters to identify it — never the value.

**How it physically runs** — the carrier is the security verdict comment on the pull request, which becomes a frozen fact once that pull request merges. The verdict line is written bare, on its own line, because it is machine-read twice by the same parser: before the merge, by the blocking review gate that refuses to merge without a clean pass, and after it, by the close-out that copies the verdict into the provenance record. The most recent clear verdict wins, which is how a fail that was fixed and re-passed reads as resolved rather than as a contradiction. A critical or high finding that merged anyway means a deviation was consciously accepted — it is recorded as such, not quietly dropped.


---

## Reference

**Status:** active
**Seam:** the hand-off from the Security Reviewer (producer) to the per-task Archivist (consumer).
**Single source of truth for this seam.** The two role docs do **not** redefine what crosses this boundary — they point here. `aeg-root/roles/security.md` (producer side) and `aeg-root/roles/archivist.md` (consumer side) each reference this file; this file is where the field-by-field hand-off lives, once.

---

## Why this file exists

The provenance block's template (`roles/archivist.md`) carries a `Security: PASS | FAIL→resolved` field — and before this file, nothing defined the producer obligations behind it. The Reviewer → Archivist seam had a contract; the security half of the same close-out did not, even though both verdicts are read from the same pull request by the same assembly. An unwritten seam fails the same way a vague one does: the Archivist cannot tell what the security pass established from what it merely never mentioned.

The failure mode this prevents: a `Security:` field written from memory or inference rather than copied from a frozen verdict; a `CRITICAL` or `HIGH` finding that merged under a waiver and then vanished from the record; a token ledger row fabricated for a reviewer who never reported one.

---

## The hand-off carrier

The **Security Reviewer's verdict comment** on the open (then merged) PR, plus the **merged PR itself**. The verdict comment is the producer's output; the merge is the trigger that authorizes the Archivist to begin close-out. Two mechanical readers consume the comment through one shared parser (this repo's implementation lives in `@attalabs/aeg-core`'s verdict-extraction module): the pre-merge review gate (`vinaya check review-gate`), which blocks a task PR from merging without a clean `PASS` from a principal-allowlisted author or a principal's actor-verified `vinaya/waiver:review` label (`roles/security.md` § merge gate), and the post-merge provenance assembly, which copies the most recent clear verdict into the record. The parser is line-anchored: a blockquoted, bulleted, or backticked `VERDICT:` line reads as *missing*, not as a verdict.

---

## The contract — field-by-field mapping

Every item the Security Reviewer produces in the verdict (left) has exactly one obligation for the per-task Archivist (right). A verdict missing any left-column item is malformed — the Security Reviewer refuses to post it in that state.

| Security Reviewer produces | per-task Archivist consumes at | What the consumption means |
|---|---|---|
| **Verdict** (`PASS` or `FAIL`, bare `VERDICT:` line) | Entry gate + the provenance block's `Security:` field | Close-out runs only on merged PRs, and a task PR only merges with a clean `PASS` (or a principal's actor-verified waiver). The field records the grammar `PASS \| FAIL→resolved` (`roles/archivist.md`): the most recent clear verdict, an earlier fixed-and-re-passed `FAIL` reading as resolved. An absent or unclear verdict records as DANGLING — never as an inferred pass. |
| **Finding list** with severity tags (`CRITICAL` / `HIGH` / `MEDIUM` / `LOW`) | Provenance block assembly + pinned lessons Issue | Any `CRITICAL` or `HIGH` forces `VERDICT: FAIL` (`roles/security.md`), so one present on a merged PR means the fail was resolved and re-passed — or the merge rode a waiver. A waived `CRITICAL`/`HIGH` is a consciously accepted deviation: the Archivist logs it under DANGLING and posts to the pinned lessons Issue, mirroring the `BLOCKER`/`MAJOR` row of `contracts/reviewer-archivist.md`. |
| **Token report** (the closing `Tokens: <task-id>: security — …` line) | Token ledger collection at close-out | The Archivist records one ledger row from this line, copying its figures exactly (`—` cells stay `—`). A verdict comment with no `Tokens:` line means no row — the gap is flagged under DANGLING, never filled in. |

**Reading the table:** left is the producer obligation (`roles/security.md` and this contract enforce it), right is the consumer obligation (`roles/archivist.md` and this contract enforce it). The two role docs must not contradict this table.

---

## Producer obligations (the Security Reviewer)

- The verdict line is written bare, on its own line, in the exact format specified by `roles/security.md`: `VERDICT: PASS | FAIL`. No heading, no blockquote, no code span — the machine readers are line-anchored, and a decorated verdict reads as missing.
- Every finding must carry a severity tag (`CRITICAL`, `HIGH`, `MEDIUM`, or `LOW`). Any `CRITICAL` or `HIGH` means the verdict is `FAIL` — this contract records that grammar, it does not define it; `roles/security.md` does.
- The `CONFIG SCAN:` and `SECRETS:` lines must be stated explicitly, even when the answer is `not applicable` or `none found`. An unstated scan is indistinguishable from an unrun one — and the `SECRETS:` line is evidence-backed, not asserted: the secret scanner's pasted output must appear in the verdict comment above it (`roles/security.md`, check 1).
- No discovered secret is quoted in full — file, line, and enough characters to identify it. The verdict comment becomes a permanent record at merge; a full value in it is the second leak.
- The comment closes with the one-line token report (`roles/security.md` § turn-end).
- A re-pass after the Developer's fixes posts a **new** verdict comment, never edits the prior one — most-recent-wins is how the record tells a resolved fail from a contradiction.
- A verdict comment missing any of these elements is malformed. The Security Reviewer does not post it.

## Consumer obligations (the per-task Archivist)

- Do not run close-out on unmerged PRs. The merge is the authorization signal — confirmed by querying the forge, not by reading a status field.
- **Read the verdict before recording it.** Before writing or re-confirming the `Security:` field, read the frozen verdict comment from the PR itself and paste what was read into the close-out report *(in this repo)*:

  ```
  gh pr view <N> --json comments \
    --jq '[.comments[].body | select(test("(?m)^\\s*\\**VERDICT:\\s*(PASS|FAIL)"))] | last'
  ```

  A `Security:` field written without that read is authored, not assembled — the exact failure this contract exists to prevent.
- Copy, never judge: `PASS` records as `PASS`; an earlier `FAIL` fixed and re-passed records as resolved; an absent or unclear verdict records as DANGLING. Close-out is bookkeeping, not a second security review.
- A `CRITICAL` or `HIGH` finding present in the verdict history of a merged PR means a deviation was approved. Log it in the provenance block under DANGLING and post a new comment on the pinned lessons Issue.
- Record the token ledger row from the verdict comment's `Tokens:` line, exactly as reported. A missing line is flagged under DANGLING; a row is never fabricated for it.

---

## Changing this contract

A contract changes **as a unit**. You may not change what the Security Reviewer produces without, in the same change, updating what the per-task Archivist consumes — because the property that makes the seam sound is that the producer's output side is *identical* to the consumer's input side. Concretely:

- A change to this file is a **Tier 3** change: it alters a cross-role contract, so the reasoning belongs in the pull request that makes it, where the reviewer and the close-out both read it.
- The same PR that edits this contract must verify both `aeg-root/roles/security.md` and `aeg-root/roles/archivist.md` still point here and still match the table.
- Never edit one side's role doc to add/drop a hand-off field directly. Add/drop it **here**; the role docs inherit it by reference.

---

*This contract is the seam. The Security Reviewer fills the left column; the per-task Archivist drains the right. One source of truth, changed as a unit.*
