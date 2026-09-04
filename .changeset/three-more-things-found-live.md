---
"@attalabs/vinaya": patch
"@attalabs/aeg-core": patch
---

Three more fixes found live fixing PR `#417`'s own test flakiness: `apps/cli`'s `test` script now passes `--timeout=30000` (a root `bunfig.toml` `[test]` timeout alone does not work on this bun version — verified, not assumed); the generated pre-push hook runs the affected test suite at `--concurrency=1` so a machine already busy with other work doesn't push a git-clone-heavy fixture test past its timeout, while CI's dedicated runner keeps turbo's default concurrency; and `aeg-root/roles/developer.md` plus the rendered brief's §6/§8 no longer tell the Developer to manually run the affected suite per Part now that the pre-push hook enforces it on the one push.
