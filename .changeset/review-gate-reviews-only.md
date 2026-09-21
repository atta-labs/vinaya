---
"@attalabs/aeg-core": patch
"@attalabs/vinaya": patch
---

The review gate now checks reviews and nothing else. It used to fail whenever any other check-run on the pull request's head was red, or whenever a `[principal]` Test Plan box was still unticked — so a red sibling check was reported twice under two names, and a generated workflow existed only to re-run the gate when CI completed so it could read those other results. That input is gone from the evaluator, from both of its callers, and from the generated workflow set: `vinaya init`/`vinaya upgrade` no longer write the CI-complete re-run workflow. A verdict comment still re-evaluates the gate, and every verdict-binding rule (head, base, objectives version, brief hash, ruling ordinal, policy digest) is unchanged.

Adopters whose repositories already carry the retired workflow should delete `.github/workflows/vinaya-review-retrigger.yml` and drop it from `managed.files` in `vinaya.config.json`; `upgrade` regenerates managed artifacts but does not remove a retired one. Merge conditions the gate no longer enforces need their own required checks — the repository's CI is already one, and an unticked `[principal]` Test Plan item is now unenforced unless a check owns it.
