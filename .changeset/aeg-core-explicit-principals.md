---
'@attalabs/aeg-core': minor
---

The review gate, the dispatch-readiness gate and the A1 coherence check no longer fall back to a built-in Principal: `ReviewGateInput.principalAllowlist` and `DispatchGateInput.principalAllowlist` are now required, and `checkA1` lost its default for its `principalAllowlist` parameter, so a caller that supplies no list fails to compile. The aeg-core scripts that decide who counts as a Principal read the `principals` list from the repository's `vinaya.config.json` through one new reader, `readConfigPrincipals`, and exit non-zero with `add "principals": [...] to vinaya.config.json` when the file has no such list.
