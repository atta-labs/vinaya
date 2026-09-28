---
'@attalabs/aeg-core': patch
'@attalabs/vinaya': patch
---

The developer review loop now pauses when the same blocking finding — same reviewer role, same finding id — is still open in two consecutive reviewed rounds, instead of spending a third developer turn on work two turns have already failed to close. The pause is its own reason, `repeat_finding`, and its detail names the repeated key(s) (`open after two consecutive rounds: reviewer:F1`), so a Principal reading it never has to diff two rounds' reports.

Three narrowings keep this distinct from the removed "resolved nothing this round" rule: identity is the reviewer role and the finding id together, so the same id from the two roles is two findings; only a finding the effective policy treated as blocking counts, since a non-blocking one never sent the developer back; and consecutive means consecutive reviewed rounds — a red gate or a low-confidence turn between them breaks nothing, because neither produced verdicts to compare. A round that resolves nothing but raises only new blocking findings still continues.
