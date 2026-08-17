---
'@attalabs/vinaya': minor
---

**⚠️ BREAKING BEHAVIOUR CHANGE — `vinaya check` now executes what the resolver decides. Read this before upgrading: a `vinaya.config.json` that worked yesterday can refuse to run anything today.**

`vinaya check`'s execution moves off the flat `core + config` concat and onto the resolver that has fed `vinaya check --plan` since 0.9.0. Three behaviour changes land together:

1. **Replace semantics.** A `checks` key that exactly matches a core check id now **REPLACES** that core check. Previously both ran — the core one and yours, under the same name, producing two conclusions. The core check no longer runs at all.

2. **Namespace rejection.** A bare, un-namespaced key that matches no core check id is now **REJECTED**. Every non-override key must be `<yourname>/<id>`, with both segments matching `[a-z0-9][a-z0-9-]*` and `vinaya` reserved as a prefix. **Adding a prefix is not always enough:** if the bare name itself breaks that grammar — `my_check` (underscore), `QALint` (uppercase) — it still breaks it after prefixing, and needs a real rename.

3. **`FAIL_CLOSED` is live.** A malformed `checks` entry, a rejected bare key, or a duplicate resolved id now makes the whole run **refuse**: exit 1, loud, with **nothing executed**. Before this release, an invalid config still ran the core checks; after it, nothing runs. There is no `--skip-broken` escape hatch and no core-only fallback — a partially-applied ruleset that still prints green is exactly what this refuses to produce.

**This can break an adopter's CI.** That is intended — an invalid registration silently running a subset of your gates is the failure mode being closed — but it means the upgrade is not a no-op for any repo whose `checks` block is not already clean.

**Before upgrading, run `vinaya check --plan` on 0.9.0.** It prints the exact resolution this release executes: every `FAIL_CLOSED` row it shows is a run that will now refuse, and every `overridden` row is a core check that will now stop running. `--plan` and execution read the same resolution, so what the plan prints is what runs.

**Diagnosing a refused config.** The two grace-period warnings 0.9.0 printed from `vinaya check` are gone from check output — a refused run prints its refusal instead. They live on permanently as `vinaya doctor` diagnostics: the override class at `warn`, the rejected-bare-key class at `error`, naming the rename requirement. A config that now runs nothing is still fully diagnosable through `vinaya doctor`.
