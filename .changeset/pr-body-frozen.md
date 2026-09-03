---
"@attalabs/aeg-core": minor
"@attalabs/vinaya": minor
---

`vinaya pr create` now posts an `<!-- aeg:body-hash:<hex> -->` marker comment at open — the hash of the PR body's authored region (every `ANCHOR_FIELDS` region stripped by outer bounds, every ticked checkbox normalised to unticked). A new `pr-body-frozen` check re-reads that comment and refuses any later PR body whose authored region no longer matches it, mechanizing the frozen-body rule `aeg-root/roles/developer.md` already states in prose: the body is written once at open and never hand-edited again, except an `AEG:EVIDENCE` regeneration or an appended `AEG:TOKENS` row. A PR with no marker comment from an allowlisted author (every PR open before this shipped) is grandfathered — the check reports `info`, never `fail`. `ANCHOR_FIELDS` (`@attalabs/aeg-core`) widens from six fields to seven, adding `TOKENS` — `pr-report.ts` already used that identical anchor grammar for the Token report table, unregistered; the registry widened rather than gaining a second, parallel field list.
