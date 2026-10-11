---
'@attalabs/aeg-core': patch
---

The pull-request-report density rule no longer counts the driver's `AEG:BEYOND-SURFACE` block as a Scope paragraph. The rule strips every marked driver-owned block before counting, as it already did for the other fields, so a one-paragraph Scope carrying a populated or empty beyond-Surface block passes, while a Scope with two real paragraphs still fails. Before this, any pull request whose Scope carried the block was refused on every body write.
