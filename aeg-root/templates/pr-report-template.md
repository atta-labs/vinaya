---
sidebar_title: "Template: PR report"
---
# Template — Developer's PR report (the PR body)

**Copy the block below the divider into the PR body file (opened via `open-pr.ts --body-file`) and replace every `[…]` placeholder with real content.** This packages the canonical PR-body form defined by `aeg-root/roles/developer.md` § "PR body — canonical form" — that section remains the contract for what each field requires (exact `Tier:` syntax, tagging rules, the optional `Conforms-to:`/`Doc-ack:`/`Doc-waiver:` fields); this file is the container.

**The anchor comments are load-bearing.** Each gate-read field — `Closes #N`, `Project:`, `Tier:`, the Test Plan section, the Premise block, the Evidence block — sits inside an AEG anchor pair (an HTML comment pair, invisible on the rendered PR). When an anchor pair for a field is present, every gate reads that field **exclusively from inside the pair**, ignoring identical-looking text anywhere else in the body — a pasted reference brief, a quoted example, a duplicate section can no longer be mistaken for the real field. Bodies without anchors remain fully recognized (prose recognition is the compatibility fallback) for every field **except Evidence**, which has no prose fallback — it is never hand-typed. Use at most one anchor pair per field. Keep the anchors when you fill this in.

**The `AEG:PREMISE` anchor is not optional when the brief carried a `Premise:` block.** Without it, `premise-recheck` scans the *whole* body for anything premise-shaped — and re-asserts those against the code you just changed. A premise pinning the *pre-fix* state will correctly fail once your fix lands, because the pin describes what you just changed away from. Put a fresh, post-fix, currently-true assertion inside `<!-- AEG:PREMISE:START -->` / `<!-- AEG:PREMISE:END -->` so the re-check asserts something true of the shipped diff, not the brief's stale snapshot — this holds even though the brief's own original pins no longer live in the *posted* body at all: `pr create` splits the `## Reference` section (below) out into the separate `aeg:brief` PR comment before the body ever reaches the forge.

**No bare digit outside a fenced block.** `body-bare-digits` (CI) refuses a countable claim — a test count, a file count, a timing figure, "N passed" — written loose in a sentence anywhere in this body. A digit is exempt for exactly one reason: it sits inside an inline code span or a fenced/indented code block (`` `N` `` or a fenced block), or inside `Closes #N`/`Project:` (this header block) / `Tier:` (under `## Scope`) / `Evidence` (under `## Evidence`), correctly placed under its own documented section. **Nowhere else** — including inside `Premise`/`Test plan` (both scanned exactly like ordinary prose, no anchor exemption at all — evidence there, byte counts, exit codes all need their own backticks too), an Issue/PR reference, a date, a version, a file path, or a section number: any of those now needs its own backticks (`` `#N` ``, `` `2026-08-18` ``, `` `0.12.0` ``) the same as any other digit. Write the number inside a fenced block or backticks, or don't write it bare at all.

---

<!-- AEG:CLOSES:START -->
Closes #[N]
<!-- AEG:CLOSES:END -->

**For:** [model + environment that executed the task, matching the brief's `For:` line]
<!-- AEG:PROJECT:START -->
**Project:** [project(s), comma-separated, matching the brief]
<!-- AEG:PROJECT:END -->

## Summary

[SUMMARY — one paragraph: what shipped and the durable why. Then the decisions you made that weren't explicit in the brief — name the alternatives and why you picked yours, so the Principal can reverse a wrong call. No verification claims here (no "typecheck passes", no diff stats, no test counts) — those go in the emitted Evidence block below, never typed by hand.]

## Test plan

<!-- AEG:TEST-PLAN:START -->
- [ ] **[agent]** [item carried from the brief's §9 — tick only after running it; the tick is the only mark this line ever carries, never the pasted command output, which goes in the round comment headed `Head: <sha>` instead]
- [ ] **[principal]** [item carried from the brief's §9 — the Principal ticks after verifying in a real browser/session]
<!-- AEG:TEST-PLAN:END -->

## Premise

<!-- AEG:PREMISE:START -->
**Premise:**
- [path/inside/the/shipped/diff.ts] contains: [a literal substring that is TRUE of the code AFTER your fix — never the brief's original pre-fix pin]
<!-- AEG:PREMISE:END -->

[Omit this whole section — anchors and all — only when §4 of the brief had no real code surface (a Tier 0 doc-only or planning-only change). Any brief with a `Premise:` block gets a fresh one here; do not rely on the brief's original block as a substitute — `pr create` splits it into the separate `aeg:brief` PR comment, never the posted body, and the re-check reads this anchored section, not that comment.]

## Evidence

Run `vinaya pr report --write <this-body-file>` and commit its output — this block is generated, never hand-typed. `check-evidence-fresh` refuses a body whose block doesn't match the head it's attached to.

The block opens with `Head:` and a `Summary:` line — a file and line count derived from the same `--numstat` printed two lines below it, so the body never needs a hand-written "four files changed" sentence that a later commit silently falsifies. Its value is emitted inside backticks, which is what makes it legal under the bare-digit rule below — no exemption, just the same inline code span any other digit needs. Do not type or edit the line: `check-evidence-fresh` byte-compares it, backticks included, against a fresh recompute, and a hand-written count fails there.

**Keep the anchor pair out of the `<details>` block.** `body-bare-digits` blanks every digit inside a collapsed block, so an evidence block hidden in one is exempt from the digit scan and unverifiable — `check-evidence-fresh` refuses rather than passing silently. Both checks resolve this region from one shared, normalised context, so a zero-width character or an HTML entity in a marker no longer makes one of them see a block the other cannot.

<!-- AEG:EVIDENCE:START -->
[run `vinaya pr report --write` to populate — do not type this block by hand]
<!-- AEG:EVIDENCE:END -->

## Scope

[SCOPE — one paragraph: blast radius, projects touched, packages edited, shared-package consumers affected, non-goals. Ends with the Tier field:]

<!-- AEG:TIER:START -->
**Tier:** [0 | 1 | 3]
<!-- AEG:TIER:END -->

## Token report

<!-- AEG:TOKENS:START -->
| Phase | Role | Agent/Model | Tokens in | Tokens out | Cost | Date |
|---|---|---|---|---|---|---|
| [task-id]: develop | Developer | [model] | [exact in] | [exact out] | [cost] | [YYYY-MM-DD] |
<!-- AEG:TOKENS:END -->

---

<!-- aeg:brief:start -->
## Reference — the dispatched brief

[paste the entire dispatched brief here, verbatim]
<!-- aeg:brief:end -->

**`pr create` splits this section out — never sends it to the forge as body text.** Everything from the `aeg:brief:start` marker to `aeg:brief:end` — this whole `## Reference` section — is extracted and posted as its own PR comment marked `<!-- aeg:brief -->`, immediately after the body-hash marker, once, at open. The body `gh pr create` actually receives ends at the divider above it; paste the brief here exactly as before, the split is mechanical, not a change to what you author.

**This body is written once, at open.** After the PR is open the Developer changes nothing outside the `AEG:EVIDENCE` anchor and one appended `AEG:TOKENS` row. The Principal's `[principal]` ticks are the Principal's writes and must survive every Developer edit. A round's response, its re-run evidence, and any disclosure the brief didn't anticipate are PR comments, never edits to this body.
