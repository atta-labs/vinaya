---
"@attalabs/aeg-core": patch
"@attalabs/vinaya": patch
---

The published round summary reports nothing for a round whose finding counts are unknown, instead of a zero a reader takes for a clean round. A round rebuilt from the pull request's own round markers after a driver restart has no finding breakdown at all — a marker names a round's number and head and nothing else — and the table rendered each of those missing counts as `0`. On one real task's published summary, four rounds read as zero findings when the truth was that nobody knew. Those cells now carry the table's own not-reported glyph, the same one the confidence column already used for "nothing to report". A round the loop assessed still reports numbers, including a genuine zero: `assessRound` now records every severity column at zero before counting a single finding, so a round it measured and found nothing in is a recorded zero rather than an absent count, and the renderer tells the two apart by whether any column was recorded — never by the value. The summary's header row is unchanged, so the detection that decides whether a summary was ever published reads exactly as before.
