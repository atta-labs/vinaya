---
"@attalabs/vinaya": patch
---

Correct `aeg-root/enforcement.md`'s ring-table implementation pointers to the mechanisms that actually run in a vinaya-governed repo — the managed `.git/hooks/pre-commit`/`pre-push` blocks, the validated `vinaya issue|pr` forge-write commands, the required review-gate check, and the `vinaya-*.yml` workflows — instead of the attalabs-only `.husky/*`, `.claude/hooks/*`, and `forge-lifecycle.yml` paths, which do not exist in an adopter repo (measured live by the `registry-gates` G1 check during the first tranche cut natively in atta-labs/vinaya). `aeg-root/` ships in the published tarball, so the stale pointers were the account every adopter got.

Also records, in `apps/cli/specs/self-hosting.md` (unpublished), what that first forge-native walk measured: the authoring-time vs CI brief-shape divergence, the file-topology phrasing still present in some refusal text and baselines, and the Planner-surface gap (no CLI path for Milestone or tranche-label creation).
