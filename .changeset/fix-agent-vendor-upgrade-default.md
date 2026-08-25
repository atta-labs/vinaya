---
"@attalabs/vinaya": patch
---

`resolveAgentVendors` treated a manifest whose `agents` key was never written (any install predating the agent-vendor feature) the same as an explicit `--agents=none` — both resolved to an empty Set. That meant `vinaya upgrade`/`doctor` would never add `.claude/commands/vinaya.md`, `.gemini/commands/vinaya.toml`, or `.agents/skills/` to a pre-existing install, no matter how many `upgrade` runs it went through — the only way to get them was to re-run `vinaya init --agents=all` by hand. Found live: attalabs' own installed copy silently never got these files.

`undefined` (the key never existed) now defaults to every vendor — the same default `vinaya init` gives a fresh install — while an explicit `agents: []` from `--agents=none` is still respected exactly, never widened. `isDefaultedAgentVendorPath` gates the same distinction in `upgrade`'s file-ownership check, so both halves agree.
