---
"@attalabs/aeg-core": minor
"@attalabs/vinaya-sources": patch
"@attalabs/vinaya": minor
"@attalabs/aeg-forge-state": patch
---

`reader-resolvable-prose` gains a source-comment class: it scans comment lines of `.ts` files under `proseGates.sourceComments.globs` in `vinaya.config.json` for a tranche-slug or forge-number citation, honours `proseGates.sourceComments.allowlist`, and reports at `warning` severity until `proseGates.sourceComments.severity` is set to `error`. `tranchesAttachedToMilestone` and `vinaya archive tranche`'s Issue fetch now paginate past the first 100-item page instead of silently truncating a large Milestone.
